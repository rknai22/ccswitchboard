// === GRACE START_BLOCK: broker_sessions =======================================
// MODULE_CONTRACT:
//   IN:  the topic registry (store), shim connection state (ctx.isConnected),
//        config: runner, orca, projects_root, claude_cmd; templates/ next to
//        the broker for each topic's CLAUDE.local.md.
//   OUT: ensure(name) — make sure the topic has a folder and a running Claude
//        session in an Orca terminal; prepareFolder(); the watchdog (every
//        60 s) that relaunches sessions whose shim is gone; signals to General
//        ("session is down" / "back up", "Orca is not answering").
//   INV: alive = the topic's shim is connected and bound. Nothing else (a
//        terminal in Orca, a claude process) counts: only a bound shim
//        receives the topic's messages.
//   INV: at most one launch per topic per 120 s — the lock is kv
//        "topic:<name>:launch_at", written BEFORE the terminal is created, so
//        neither a broker restart nor two concurrent ensure() calls can start
//        a second session for the same topic.
//   INV: a live Claude with the topic's key is a live session even while its
//        shim is not connected: it is never closed or relaunched for that
//        (the owner hears "alive but cannot reach the broker"); only a
//        reopened topic replaces our own terminal.
//   INV: one Claude per topic across Orca restarts: a terminal is closed only
//        when its handle or tabId is in the topic's launch history, and a
//        launch is skipped (owner told) while a process with the topic's key
//        lives outside the terminals we can prove — or, when processes cannot
//        be counted, while unrecognised terminals sit in the topic folder.
//        After Orca comes back, launches wait launchGapMs for restored shims.
//   INV: closed topics are never (re)started; folders are never deleted.
//   INV: a folder is trusted (~/.claude.json) only when it sits directly in
//        projects_root — the broker never vouches for folders it did not make.
//   INV: a live Claude whose shim is gone (alive_unreachable / blocked_alive)
//        is healed with /mcp → Reconnect typed into its only terminal when it
//        looks idle (config.heal; see heal.ts) — never closed: after
//        healTiming.maxFails failures the owner gets a Restart button in
//        General, and only that press closes the terminal (the one named in
//        the button) and relaunches with --resume.
//   INV: a topic's terminal is created in the topic's own Orca project
//        (id:<repo-id>::<cwd>): by path, Orca files a folder that is a git
//        worktree of another repo under that other project.
//   INV: all session-machine commands go through runOnSessionHost as argv; the
//        topic key appears only inside the terminal command (accepted by the
//        spec: topics are not isolated from each other), never in logs.

import { readFileSync } from 'fs'
import type { Update } from 'grammy/types'
import { randomBytes } from 'crypto'
import type { BrokerContext, BrokerModule } from './context.ts'
import { HEAL_PY, healDecision, healTiming, parseHeal, repoIdFor, type HealState } from './heal.ts'
import { expandHome, initRunner, runOnSessionHost, sessionHome, type RunResult } from './runner.ts'
import { t } from './strings.ts'

export const timing = {
  tickMs: 60_000,
  /** min gap between two launches of one topic; also "not up within" limit */
  launchGapMs: 120_000,
  /** after a broker (re)start shims need a moment to reconnect */
  startGraceMs: 120_000,
  /** per topic and per kind of signal in General */
  noticeGapMs: 15 * 60_000,
  orcaStatusCacheMs: 20_000,
  /** after closing our terminal, how long to wait for its claude to exit */
  closeSettleMs: 5_000,
}
const CMD_TIMEOUT_MS = 20_000
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TEMPLATES = new URL('../../templates/', import.meta.url)

// Folder preparation on the session machine in one round trip. Reports every
// step so a failure halfway is told as "what was done and what was not".
const PREP_PY = String.raw`
import json, os, subprocess, sys
cwd, root, gpt = sys.argv[1:4]
tpl = sys.stdin.read()
rep = {"ok": False}
def out():
    print(json.dumps(rep)); sys.exit(0)
def git(*a):
    return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, timeout=30)
try:
    if os.path.dirname(os.path.normpath(cwd)) != os.path.normpath(root):
        rep["error"] = "folder is not directly inside projects_root"; out()
    existed = os.path.isdir(cwd)
    if os.path.exists(cwd) and not existed:
        rep["error"] = "path exists and is not a folder"; out()
    os.makedirs(cwd, exist_ok=True)
    rep["folder"] = "exists" if existed else "created"
    if os.path.exists(os.path.join(cwd, ".git")):
        rep["git"] = "exists"
    elif existed and os.listdir(cwd):
        rep["error"] = "folder exists, is not empty and is not a git repository"; out()
    else:
        r = git("init", "-q")
        if r.returncode != 0:
            rep["error"] = "git init failed: " + r.stderr.strip()[:200]; out()
        # Orca and most git tooling expect a HEAD; a fresh repo has none.
        r = git("-c", "user.name=ccswitchboard", "-c", "user.email=ccswitchboard@localhost",
                "commit", "-q", "--allow-empty", "-m", "Initial empty commit (ccswitchboard)")
        rep["git"] = "initialized" if r.returncode == 0 else "initialized, no initial commit: " + r.stderr.strip()[:200]
    p = os.path.join(cwd, "CLAUDE.local.md")
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "w") as f: f.write(tpl)
        rep["claude_local"] = "written"
    except FileExistsError:
        rep["claude_local"] = "kept"
    r = git("rev-parse", "--git-path", "info/exclude")
    if r.returncode != 0:
        rep["error"] = "cannot locate .git/info/exclude: " + r.stderr.strip()[:200]; out()
    ex = r.stdout.strip()
    if not os.path.isabs(ex): ex = os.path.join(cwd, ex)
    os.makedirs(os.path.dirname(ex), exist_ok=True)
    # The session's own files must never ride into the project's commits:
    # its instructions and its status board (free text about the work).
    text = open(ex).read() if os.path.exists(ex) else ""
    have = {l.strip().lstrip("/") for l in text.splitlines()}
    missing = [n for n in ("CLAUDE.local.md", "STATUS.json") if n not in have]
    if missing:
        with open(ex, "a") as f:
            if text and not text.endswith("\n"): f.write("\n")
            for n in missing: f.write("/" + n + "\n")
        rep["exclude"] = "added " + ",".join(missing)
    else:
        rep["exclude"] = "present"
    os.makedirs(gpt, exist_ok=True)
    rep["gpt"] = "ok"
    rep["ok"] = True
except Exception as e:
    rep["error"] = type(e).__name__ + ": " + str(e)[:300]
out()
`

// Claude Code state on the session machine. mode "prelaunch": trust the
// folder, accept the bypass-permissions dialog once, check that the transcript
// to --resume still exists. mode "discover": newest transcript of the folder
// written since <since_ms>. JSON files are edited field by field (read, set,
// write to a temp file, rename): Claude Code keeps much more in them.
const SESSION_PY = String.raw`
import glob, json, os, re, sys, tempfile
mode, cwd, root, arg = sys.argv[1:5]
home = os.path.expanduser("~")
base = os.path.join(home, ".claude", "projects")
def projdirs():
    out = []
    for p in {cwd, os.path.realpath(cwd)}:
        e = re.sub(r"[^a-zA-Z0-9]", "-", p)
        out += [os.path.join(base, e)] if len(e) <= 200 else glob.glob(os.path.join(base, glob.escape(e[:200]) + "-*"))
    return out
def edit(path, fn):
    try:
        with open(path) as f: data = json.load(f)
    except FileNotFoundError:
        data = {}
    if not isinstance(data, dict): raise ValueError("not a JSON object")
    if not fn(data): return "already"
    mode_ = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    d = os.path.dirname(path); os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".ccsb-")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2); f.write("\n")
    os.chmod(tmp, mode_); os.replace(tmp, path)
    return "set"
rep = {}
if mode == "prelaunch":
    real = os.path.realpath(cwd)
    if not root or os.path.dirname(real) != os.path.realpath(root):
        rep["trust"] = "skipped: outside projects_root"
    else:
        def trust(d):
            pr = d.setdefault("projects", {})
            if not isinstance(pr, dict): raise ValueError("projects is not an object")
            changed = False
            for k in {cwd, real}:
                e = pr.setdefault(k, {})
                if e.get("hasTrustDialogAccepted") is not True:
                    e["hasTrustDialogAccepted"] = True; changed = True
            return changed
        try: rep["trust"] = edit(os.path.join(home, ".claude.json"), trust)
        except Exception as e: rep["trust"] = "error: " + str(e)[:200]
    def skip(d):
        if d.get("skipDangerousModePermissionPrompt") is True: return False
        d["skipDangerousModePermissionPrompt"] = True; return True
    try: rep["bypass_prompt"] = edit(os.path.join(home, ".claude", "settings.json"), skip)
    except Exception as e: rep["bypass_prompt"] = "error: " + str(e)[:200]
    if arg:
        rep["resume"] = any(os.path.isfile(os.path.join(d, arg + ".jsonl")) for d in projdirs())
elif mode == "discover":
    since = float(arg) / 1000 - 2
    best = None
    for d in projdirs():
        for f in glob.glob(os.path.join(glob.escape(d), "*.jsonl")):
            m = os.path.getmtime(f)
            if m >= since and (best is None or m > best[0]): best = (m, f)
    rep["session_id"] = os.path.basename(best[1])[:-6] if best else None
print(json.dumps(rep))
`

let ctxRef: BrokerContext | null = null
let startedAt = Date.now()
let tickTimer: ReturnType<typeof setInterval> | null = null
let ticking = false
const chains = new Map<string, Promise<unknown>>()
/** last tick that saw the topic connected — a blip between ticks is not a crash */
const lastSeen = new Map<string, number>()
let orcaCache: { at: number; up: boolean } | null = null

const k = (name: string, field: string) => `topic:${name}:${field}`

function ctx(): BrokerContext {
  if (!ctxRef) throw new Error('sessions module is not started')
  return ctxRef
}

function num(v: string | undefined): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Parse a CLI's JSON stdout; tolerate a banner line before the object. */
export function parseJson(out: string): any {
  try {
    return JSON.parse(out)
  } catch {}
  const a = out.indexOf('{')
  const b = out.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(out.slice(a, b + 1))
    } catch {}
  }
  return undefined
}

function render(file: string, vars: Record<string, string>): string {
  const raw = readFileSync(new URL(file, TEMPLATES), 'utf8')
  return raw.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m)
}

/** Titles end up inside CLAUDE.local.md: one line, no control characters. */
export function cleanTitle(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined
  const v = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 128)
  return v || undefined
}

async function orca(args: string[], label: string): Promise<RunResult> {
  return runOnSessionHost([ctx().config.orca, ...args], { timeoutMs: CMD_TIMEOUT_MS, label })
}

function orcaError(r: RunResult, secret?: string): string {
  const j = parseJson(r.stdout) ?? parseJson(r.stderr)
  const code = j?.error?.code ?? j?.code
  let text = (j?.error?.message ?? r.stderr ?? '').toString()
  if (secret) text = text.split(secret).join('<key>')
  return `${r.timedOut ? 'timeout' : `exit ${r.code}`}${code ? ` ${code}` : ''}${text ? `: ${text.trim().slice(0, 200)}` : ''}`
}

// ---- folder ---------------------------------------------------------------------

export type PrepareResult = { ok: boolean; cwd?: string; steps: Record<string, string>; error?: string }

/** Create (or adopt) <projects_root>/<name> on the session machine: git repo,
 *  CLAUDE.local.md from the template if absent, excluded from git, and the
 *  ChatGPT pairing folder ~/gpt/<name>. Records cwd on success. */
export async function prepareFolder(name: string): Promise<PrepareResult> {
  const c = ctx()
  const row = c.store.topic(name)
  if (!row) return { ok: false, steps: {}, error: `unknown topic ${name}` }
  let home: string
  let root: string
  try {
    home = await sessionHome()
    root = await projectsRoot()
  } catch (e) {
    return { ok: false, steps: {}, error: e instanceof Error ? e.message : String(e) }
  }
  const cwd = `${root}/${name}`
  const title = cleanTitle(row.title) ?? name
  let tpl: string
  try {
    tpl = render(name === 'general' ? 'CLAUDE.general.md' : 'CLAUDE.topic.md', { name, title })
  } catch (e) {
    return { ok: false, steps: {}, error: `template unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
  const r = await runOnSessionHost(['python3', '-c', PREP_PY, cwd, root, `${home}/gpt/${name}`], {
    input: tpl, timeoutMs: 60_000, label: 'prepare_folder',
  })
  const rep = parseJson(r.stdout) as Record<string, unknown> | undefined
  if (!rep || typeof rep !== 'object') {
    c.log('prepare_failed', { topic: name, code: r.code, timed_out: r.timedOut })
    return { ok: false, steps: {}, error: `folder preparation did not report (${r.timedOut ? 'timeout' : `exit ${r.code}`}: ${r.stderr.trim().slice(0, 200)})` }
  }
  const steps: Record<string, string> = {}
  for (const [key, v] of Object.entries(rep)) if (key !== 'ok' && key !== 'error') steps[key] = String(v)
  c.log('prepare', { topic: name, ok: rep.ok === true, ...steps })
  if (rep.ok !== true) return { ok: false, cwd, steps, error: String(rep.error ?? 'unknown error') }
  c.store.updateTopic(name, { cwd })
  c.store.set(k(name, 'prepared'), 1)
  return { ok: true, cwd, steps }
}

// ---- Orca -------------------------------------------------------------------------

async function orcaUp(): Promise<boolean> {
  const c = ctx()
  if (orcaCache && Date.now() - orcaCache.at < timing.orcaStatusCacheMs) return orcaCache.up
  const r = await orca(['status', '--json'], 'orca_status')
  const j = parseJson(r.stdout)
  let up = r.code === 0
  if (up && j?.ok === false) up = false
  if (up && j?.result?.runtime && j.result.runtime.reachable === false) up = false
  if (r.code === 0 && j?.result?.runtime?.reachable === undefined) c.log('orca_status_shape', { has_json: j !== undefined })
  orcaCache = { at: Date.now(), up }
  // Orca coming back — after being down, or with a new runtime id (it
  // restarted between two checks) — may restore our tabs and re-run their
  // commands; launches wait launchGapMs so restored shims can reconnect first.
  // The very first observation is not a "coming back".
  const runtimeId = j?.result?.runtime?.runtimeId ?? j?._meta?.runtimeId
  const prevRuntime = c.store.get('sessions:orca_runtime')
  const wasDown = c.store.get('sessions:orca_state') === 'down'
  if (up) {
    if (wasDown || (typeof runtimeId === 'string' && prevRuntime !== undefined && prevRuntime !== runtimeId)) {
      c.store.set('sessions:orca_up_since', Date.now())
      c.log('orca_back', { was_down: wasDown, runtime_changed: !wasDown })
    }
    if (typeof runtimeId === 'string') c.store.set('sessions:orca_runtime', runtimeId)
    c.store.set('sessions:orca_state', 'up')
  } else {
    c.store.set('sessions:orca_state', 'down')
  }
  if (!up) {
    c.log('orca_down', { err: orcaError(r) })
    const last = num(c.store.get('sessions:orca_notice_at'))
    if (Date.now() - last >= timing.noticeGapMs) {
      c.store.set('sessions:orca_notice_at', Date.now())
      void c.notifyGeneral(t(c.config.lang, 'orca_down'))
    }
  }
  return up
}

function reposOf(j: any): string[] {
  const list = j?.result?.repos ?? j?.repos ?? (Array.isArray(j) ? j : undefined)
  if (!Array.isArray(list)) return []
  return list.map((x: any) => x?.path).filter((p: unknown): p is string => typeof p === 'string').map(p => p.replace(/\/+$/, ''))
}

/** Orca opens terminals only in registered repos; register once per folder. */
async function ensureRepo(name: string, cwd: string): Promise<void> {
  const c = ctx()
  if (c.store.get(k(name, 'repo_added')) === '1') return
  const listed = async () => {
    const r = await orca(['repo', 'list', '--json'], 'orca_repo_list')
    const j = parseJson(r.stdout)
    if (r.code !== 0 || j === undefined) c.log('repo_list_failed', { err: orcaError(r) })
    else if (!Array.isArray(j?.result?.repos)) c.log('repo_list_shape', { keys: Object.keys(j ?? {}).join(',') })
    return reposOf(j).includes(cwd)
  }
  if (await listed()) {
    c.store.set(k(name, 'repo_added'), 1)
    return
  }
  // Current CLI: `repo add --path <p>`; older builds took the path positionally.
  let r = await orca(['repo', 'add', '--path', cwd, '--json'], 'orca_repo_add')
  if (r.code !== 0 && !(await listed())) r = await orca(['repo', 'add', cwd, '--json'], 'orca_repo_add_positional')
  if (r.code === 0 || (await listed())) {
    c.store.set(k(name, 'repo_added'), 1)
    c.log('repo_added', { topic: name })
  } else {
    c.log('repo_add_failed', { topic: name, err: orcaError(r) })
  }
}

function terminalsOf(j: any): any[] {
  const list = j?.result?.terminals ?? j?.terminals ?? (Array.isArray(j) ? j : undefined)
  return Array.isArray(list) ? list : []
}

// ---- which terminals are ours ---------------------------------------------------
//
// What Orca 1.4.238 gives us (read from its CLI and runtime source):
//   handle   — "term_<random uuid>" issued per runtime from in-memory maps: a
//              new one after every Orca restart;
//   title    — the pane's live title: Claude rewrites it via OSC, so the
//              "tg:<name>" we pass is gone within seconds; the tab's custom
//              title is persisted but not exposed by `terminal list`;
//   tabId    — the tab's entity id from the persisted workspace layout;
//   worktreePath — the folder the terminal belongs to.
// So a terminal is OURS only when its handle or its tabId is one we recorded
// at launch (topic:<name>:terminals); title and folder alone prove nothing —
// the owner opens terminals in the same folders by hand. A terminal we cannot
// prove is ours is never closed.
//
// What survives everything is the process: the launched claude carries
// CCSB_KEY=<this topic's key> in its environment. Before launching we count
// such processes on the session machine; if one is alive outside the
// terminals we can prove, we do not start a second session — the owner is
// told instead.

type TermRef = { handle?: string; tabId?: string }
const HISTORY_MAX = 10

function history(name: string): TermRef[] {
  const c = ctx()
  let list: TermRef[] = []
  try {
    const v = JSON.parse(c.store.get(k(name, 'terminals')) ?? '[]')
    if (Array.isArray(v)) list = v.filter(x => x && typeof x === 'object')
  } catch {}
  const legacy = c.store.get(k(name, 'handle'))
  if (legacy && !list.some(x => x.handle === legacy)) list.push({ handle: legacy })
  return list
}

function remember(name: string, ref: TermRef): void {
  const list = [ref, ...history(name).filter(x => !(ref.handle && x.handle === ref.handle) && !(ref.tabId && x.tabId === ref.tabId))]
  ctx().store.set(k(name, 'terminals'), JSON.stringify(list.slice(0, HISTORY_MAX)))
}

const normPath = (p: unknown) => (typeof p === 'string' ? p.replace(/\/+$/, '') : '')

type Census = {
  /** terminal list answered */
  listOk: boolean
  /** provably ours: handle or tabId from our launch history */
  ours: { handle: string; tabId?: string }[]
  /** other terminals in the topic folder — the owner's, or ours unrecognisable */
  others: number
  othersHandles: string[]
}

async function census(name: string, cwd: string): Promise<Census> {
  const c = ctx()
  const r = await orca(['terminal', 'list', '--json'], 'orca_terminal_list')
  const j = parseJson(r.stdout)
  if (r.code !== 0 || j === undefined || j?.ok === false) {
    c.log('terminal_list_failed', { topic: name, err: orcaError(r) })
    return { listOk: false, ours: [], others: 0, othersHandles: [] }
  }
  if (!Array.isArray(j?.result?.terminals)) c.log('terminal_list_shape', { keys: Object.keys(j ?? {}).join(',') })
  const hist = history(name)
  const handles = new Set(hist.map(x => x.handle).filter(Boolean))
  const tabs = new Set(hist.map(x => x.tabId).filter(Boolean))
  const out: Census = { listOk: true, ours: [], others: 0, othersHandles: [] }
  for (const x of terminalsOf(j)) {
    if (typeof x?.handle !== 'string') continue
    const inFolder = normPath(x.worktreePath) === normPath(cwd)
    const tabId = typeof x.tabId === 'string' ? x.tabId : undefined
    if (handles.has(x.handle) || (inFolder && tabId && tabs.has(tabId))) {
      out.ours.push({ handle: x.handle, ...(tabId ? { tabId } : {}) })
      // A restart gave our tab a new handle: remember it too.
      if (!handles.has(x.handle)) remember(name, { handle: x.handle, ...(tabId ? { tabId } : {}) })
    } else if (inFolder) {
      out.others++
      out.othersHandles.push(x.handle)
    }
  }
  return out
}

async function closeTerminals(name: string, list: { handle: string }[]): Promise<number> {
  const c = ctx()
  let closed = 0
  for (const x of list) {
    const cr = await orca(['terminal', 'close', '--terminal', x.handle, '--tab', '--json'], 'orca_terminal_close')
    if (cr.code === 0) closed++
    else c.log('terminal_close_failed', { topic: name, err: orcaError(cr) })
  }
  if (list.length) c.log('terminal_closed', { topic: name, found: list.length, closed })
  return closed
}

// Live Claude sessions of a topic on the session machine. CCSB_KEY=<key> is in
// the environment of claude AND of everything it starts (the shim, background
// jobs, dev servers — some outlive the session), so a key-holder counts only
// when it IS the program claude_cmd runs: its argv[0], argv[1] (interpreter
// or wrapper scripts), comm or executable has that basename. Other
// key-holders are reported (pid, comm) but never block a launch. The key comes
// on stdin, the program name in argv.
// Linux: /proc, where a same-user process's environ is readable — a real
// count, 0 included. Elsewhere `ps -E` (BSD/macOS) shows the environment of
// only some processes (not of hardened binaries): it proves presence, never
// absence, so no match there is "unknown" (n: null).
const KEYPROC_PY = String.raw`
import json, os, subprocess, sys
mark = ("CCSB_KEY=" + sys.stdin.read().strip()).encode()
prog = os.path.basename(sys.argv[1]) if len(sys.argv) > 1 else ""
me = os.getpid()
claude, others, undecided = [], [], 0
def names(*xs):
    return {os.path.basename(x) for x in xs if x}
if not prog:
    print(json.dumps({"n": None, "why": "no program name"})); sys.exit(0)
if os.path.isdir("/proc/self"):
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) == me: continue
        try:
            env = open("/proc/%s/environ" % p, "rb").read()
        except Exception:
            continue
        if mark not in env.split(b"\0"): continue
        try:
            argv = [a.decode("utf8", "replace") for a in open("/proc/%s/cmdline" % p, "rb").read().split(b"\0")]
            comm = open("/proc/%s/comm" % p).read().strip()
        except Exception:
            undecided += 1; continue
        try: exe = os.readlink("/proc/%s/exe" % p)
        except Exception: exe = ""
        rec = {"pid": int(p), "comm": comm[:32]}
        try:
            start = int(open("/proc/%s/stat" % p).read().rsplit(")", 1)[1].split()[19]) / os.sysconf("SC_CLK_TCK")
            rec["age"] = int(float(open("/proc/uptime").read().split()[0]) - start)
        except Exception:
            pass
        if prog in names(argv[0] if argv else "", argv[1] if len(argv) > 1 else "", exe) or comm == prog[:15]:
            claude.append(rec)
        else:
            others.append(rec)
    n = None if undecided else len(claude)
else:
    r = subprocess.run(["ps", "-E", "-ww", "-o", "pid=,comm=,args=", "-U", str(os.getuid())], capture_output=True)
    if r.returncode != 0:
        print(json.dumps({"n": None, "why": "ps failed"})); sys.exit(0)
    for line in r.stdout.split(b"\n"):
        parts = line.split()
        if len(parts) < 3 or parts[0] == str(me).encode() or mark not in parts[2:]: continue
        # BSD comm is cut to 16 chars (a long path loses its basename); argv[0]
        # names the program both for the match and in the log.
        comm = parts[1].decode("utf8", "replace")
        arg0 = parts[2].decode("utf8", "replace")
        rec = {"pid": int(parts[0]), "comm": os.path.basename(arg0)[:32]}
        (claude if prog in names(comm, arg0) else others).append(rec)
    n = len(claude) if claude else None
print(json.dumps({"n": n, "claude": claude[:10], "others": others[:10], "others_total": len(others), "undecided": undecided}))
`

/** The program claude_cmd runs: its first word that is not an env assignment
 *  or a plain launcher (env, exec, nohup, nice, command). */
export function programOf(cmd: string): string {
  for (const w of cmd.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || ['env', 'exec', 'nohup', 'nice', 'command'].includes(w)) continue
    return w.slice(w.lastIndexOf('/') + 1)
  }
  return ''
}

type KeyProc = { pid: number; comm: string; age?: number }
type KeyProcs = { n: number | null; claude: KeyProc[]; others: KeyProc[]; othersTotal: number }

/** Live Claude processes holding the topic's key (n: null when unknown). */
async function keyProcesses(key: string): Promise<KeyProcs> {
  const r = await runOnSessionHost(['python3', '-c', KEYPROC_PY, programOf(ctx().config.claude_cmd)], {
    input: key, timeoutMs: CMD_TIMEOUT_MS, label: 'key_processes',
  })
  const j = parseJson(r.stdout)
  const list = (v: unknown): KeyProc[] => (Array.isArray(v)
    ? v.filter(x => typeof x?.pid === 'number').map(x => ({
      pid: x.pid as number, comm: String(x.comm ?? '').slice(0, 32), ...(typeof x.age === 'number' ? { age: x.age as number } : {}),
    }))
    : [])
  if (r.code !== 0 || !j || typeof j !== 'object') return { n: null, claude: [], others: [], othersTotal: 0 }
  return {
    n: typeof j.n === 'number' && Number.isInteger(j.n) ? j.n : null,
    claude: list(j.claude),
    others: list(j.others),
    othersTotal: typeof j.others_total === 'number' ? j.others_total : 0,
  }
}

const procsField = (xs: { pid: number; comm: string }[]) => xs.map(x => `${x.pid}:${x.comm}`).join(',') || null

/** Close the topic's own terminals (proved by launch history) — used when the
 *  topic is deleted, before its kv (and so the history) is wiped. Terminals we
 *  cannot prove are ours are left alone. */
export function closeTopicTerminals(name: string): Promise<{ closed: number; others: number; alive: number | null }> {
  // Same per-topic queue as ensure(): no launch can interleave with the close.
  return serial(name, async () => {
    const c = ctx()
    const row = c.store.topic(name)
    if (!row?.cwd) return { closed: 0, others: 0, alive: null }
    const cen = await census(name, row.cwd)
    const closed = await closeTerminals(name, cen.ours)
    const kp = await keyProcesses(row.key)
    c.log('topic_terminals_closed', { topic: name, closed, others: cen.others, alive: kp.n, claude_pids: procsField(kp.claude) })
    return { closed, others: cen.others, alive: kp.n }
  })
}

/** "Alive but cannot reach the broker" — at most once per 15 min per topic. */
function aliveNotice(name: string, cwd: string): void {
  const c = ctx()
  const key = k(name, 'alive_notice_at')
  if (Date.now() - num(c.store.get(key)) < timing.noticeGapMs) return
  c.store.set(key, Date.now())
  void c.notifyGeneral(t(c.config.lang, 'session_alive_unreachable', { name, cwd }))
}

function blockedNotice(name: string, cwd: string, alive: boolean): void {
  const c = ctx()
  const key = k(name, 'blocked_notice_at')
  if (Date.now() - num(c.store.get(key)) < timing.noticeGapMs) return
  c.store.set(key, Date.now())
  void c.notifyGeneral(t(c.config.lang, alive ? 'session_blocked_alive' : 'session_blocked_unknown', { name, cwd }))
}

// ---- heal -----------------------------------------------------------------------------

/** The topic's live Claude has no shim. Count the miss; when healDecision
 *  says so, type /mcp → Reconnect into its only terminal and wait for the shim;
 *  after too many failures ask the owner with a Restart button. True = the
 *  shim is back. */
async function heal(name: string, cen: Census, kp: KeyProcs): Promise<boolean> {
  const c = ctx()
  const term = kp.claude.length !== 1
    ? undefined
    : cen.ours.length === 1 ? cen.ours[0]!.handle
    : !cen.ours.length && cen.othersHandles.length === 1 ? cen.othersHandles[0]
    : undefined
  if (!term) {
    c.log('heal_skipped', { topic: name, claude: kp.claude.length, ours: cen.ours.length, others: cen.others })
    return false
  }
  const st: HealState = parseHeal(c.store.get(k(name, 'heal')))
  st.strikes++
  const now = Date.now()
  const what = healDecision(st, kp.claude[0]!.age ?? null, now)
  if (what === 'ask_owner') {
    st.askedAt = now
    c.store.set(k(name, 'heal'), JSON.stringify(st))
    await askRestart(name, term)
    return false
  }
  if (what === 'wait') {
    c.store.set(k(name, 'heal'), JSON.stringify(st))
    return false
  }
  st.lastAt = now
  c.store.set(k(name, 'heal'), JSON.stringify(st))
  const r = await runOnSessionHost(['python3', '-c', HEAL_PY, c.config.orca, term, String(kp.claude[0]!.pid)], { timeoutMs: 90_000, label: 'heal' })
  const j = parseJson(r.stdout)
  let ok = false
  if (j?.ok === true) {
    for (const end = Date.now() + healTiming.connectWaitMs; Date.now() < end && !ok;) {
      await new Promise(res => setTimeout(res, 1000))
      ok = c.isConnected(name)
    }
  }
  c.log('heal', { topic: name, sent: j?.ok === true, why: String(j?.why ?? `exit ${r.code}`), connected: ok })
  // Busy, a changed screen, or a shim that is alive but cut off (network) is
  // not a failed heal — just nothing to type now.
  if (ok) c.store.del(k(name, 'heal'))
  else if (j?.ok === true || !['busy', 'changed', 'shim_alive'].includes(String(j?.why))) {
    st.fails++
    c.store.set(k(name, 'heal'), JSON.stringify(st))
  }
  return ok
}

const RESTART_TTL_MS = 24 * 3600_000

async function askRestart(name: string, handle: string, where = 'general', textKey: 'heal_failed_ask' | 'restart_confirm' = 'heal_failed_ask'): Promise<void> {
  const c = ctx()
  const nonce = randomBytes(6).toString('base64url')
  c.store.set(k(name, 'restart'), JSON.stringify({ nonce, handle, expires: Date.now() + RESTART_TTL_MS }))
  const markup = { inline_keyboard: [[{ text: t(c.config.lang, 'restart_button', { name }), callback_data: `ccsr:${name}:${nonce}` }]] }
  c.log('restart_asked', { topic: name })
  await c.tg.send(where, t(c.config.lang, textKey, { name }), { reply_markup: markup })
    .catch(e => c.log('restart_ask_failed', { topic: name, err: e instanceof Error ? e.message : String(e) }))
}

/** /restart in a topic: a Restart button there when the session has one
 *  terminal to close; a plain start when no Claude of the topic runs. */
export function requestRestart(name: string): Promise<'asked' | 'launched' | 'unclear'> {
  return serial(name, async () => {
    const c = ctx()
    const row = c.store.topic(name)
    if (!row?.cwd || row.state !== 'open') return 'unclear' as const
    const cen = await census(name, row.cwd)
    const kp = await keyProcesses(row.key)
    const term = cen.ours.length === 1 ? cen.ours[0]!.handle
      : !cen.ours.length && cen.othersHandles.length === 1 ? cen.othersHandles[0]
      : undefined
    if (term) {
      await askRestart(name, term, name, 'restart_confirm')
      return 'asked' as const
    }
    if (kp.n === 0 && !cen.ours.length) {
      c.store.del(k(name, 'launch_at'))
      return 'launched' as const
    }
    return 'unclear' as const
  }).then(async r => {
    if (r === 'launched') await ensure(name)
    return r
  })
}

/** The panel's Stop: Esc into the topic's only Claude terminal (interrupts
 *  the current turn, as Esc at the keyboard). */
export function sendEscape(name: string): Promise<boolean> {
  return serial(name, async () => {
    const c = ctx()
    const row = c.store.topic(name)
    if (!row?.cwd || row.state !== 'open') return false
    const cen = await census(name, row.cwd)
    const term = cen.ours.length === 1 ? cen.ours[0]!.handle
      : !cen.ours.length && cen.othersHandles.length === 1 ? cen.othersHandles[0]
      : undefined
    if (!term) return false
    const r = await orca(['terminal', 'send', '--terminal', term, '--text', '\x1b'], 'orca_terminal_send')
    c.log('escape_sent', { topic: name, ok: r.code === 0 })
    return r.code === 0
  })
}

/** The owner pressed Restart: close exactly the terminal named in the button
 *  (if it is still there) and relaunch with --resume. */
export async function onRestartCallback(cq: NonNullable<Update['callback_query']>): Promise<void> {
  const c = ctx()
  const answer = (key?: 'callback_done' | 'callback_expired' | 'restart_gone') =>
    c.tg.api()?.answerCallbackQuery(cq.id, key ? { text: t(c.config.lang, key, {}) } : {}).catch(() => {})
  const m = /^ccsr:([a-z0-9-]{1,32}):([A-Za-z0-9_-]+)$/.exec(cq.data ?? '')
  const owner = c.owner()
  if (!m || !owner || cq.from.id !== owner.owner_id) {
    c.log('restart_ignored', { from: cq.from.id })
    return void (await answer())
  }
  const name = m[1]!
  let req: { nonce?: string; handle?: string; expires?: number } = {}
  try { req = JSON.parse(c.store.get(k(name, 'restart')) ?? '{}') } catch {}
  const row = c.store.topic(name)
  if (!row?.cwd || row.state !== 'open' || req.nonce !== m[2] || !req.handle || (req.expires ?? 0) < Date.now()) {
    c.log('restart_stale', { topic: name })
    return void (await answer('callback_expired'))
  }
  c.store.del(k(name, 'restart'))
  const closed = await serial(name, async () => {
    const cen = await census(name, row.cwd!)
    const there = cen.ours.some(x => x.handle === req.handle) || cen.othersHandles.includes(req.handle!)
    if (!there) {
      c.log('restart_gone', { topic: name })
      await answer('restart_gone')
      return false
    }
    await answer('callback_done')
    await closeTerminals(name, [{ handle: req.handle! }])
    // Its claude needs a moment to exit; ensure() must not count it as alive.
    for (const end = Date.now() + timing.closeSettleMs; Date.now() < end;) {
      const kp = await keyProcesses(row.key)
      if (kp.n === 0) break
      await new Promise(r => setTimeout(r, 500))
    }
    c.store.set(k(name, 'force_relaunch'), 1)
    c.store.del(k(name, 'launch_at'), k(name, 'heal'))
    c.log('restart_by_owner', { topic: name })
    return true
  })
  if (!closed) return
  const res = await ensure(name)
  c.log('restart_ensure', { topic: name, launched: res.launched, reason: res.reason })
}

// ---- ensure -------------------------------------------------------------------------

export type EnsureResult = {
  launched: boolean
  /** connected | recent_launch | closed | unknown_topic | not_configured |
   *  folder_failed | orca_down | orca_settling | alive_unreachable |
   *  blocked_alive | blocked_unknown | create_failed | launched | healed */
  reason: string
  cwd?: string
  prepare?: PrepareResult
  error?: string
}

/** Run fn after everything queued for this topic (ensure, terminal close). */
function serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve()
  const run = prev.then(fn)
  chains.set(name, run.catch(() => {}))
  return run
}

/** Make sure the topic has a folder and a live session; serialized per topic. */
export function ensure(name: string): Promise<EnsureResult> {
  return serial(name, () => ensureNow(name))
}

async function ensureNow(name: string): Promise<EnsureResult> {
  const c = ctx()
  const row = c.store.topic(name)
  if (!row) return { launched: false, reason: 'unknown_topic' }
  if (row.state !== 'open') return { launched: false, reason: 'closed' }
  if (!c.isLocked()) return { launched: false, reason: 'not_configured' }
  if (c.isConnected(name)) return { launched: false, reason: 'connected', cwd: row.cwd ?? undefined }

  let cwd = row.cwd
  let prepare: PrepareResult | undefined
  if (!cwd || c.store.get(k(name, 'prepared')) !== '1') {
    // A folder that cannot be prepared (e.g. a non-git folder in the way) is
    // retried once per launch gap, not on every watchdog tick.
    const lastTry = num(c.store.get(k(name, 'prepare_at')))
    if (Date.now() - lastTry < timing.launchGapMs) {
      return { launched: false, reason: 'folder_failed', error: c.store.get(k(name, 'prepare_error')) ?? 'folder preparation failed recently' }
    }
    c.store.set(k(name, 'prepare_at'), Date.now())
    prepare = await prepareFolder(name)
    if (!prepare.ok) {
      c.store.set(k(name, 'prepare_error'), (prepare.error ?? 'unknown error').slice(0, 300))
      return { launched: false, reason: 'folder_failed', prepare, error: prepare.error }
    }
    c.store.del(k(name, 'prepare_error'))
    cwd = prepare.cwd!
  }

  const last = num(c.store.get(k(name, 'launch_at')))
  if (Date.now() - last < timing.launchGapMs) return { launched: false, reason: 'recent_launch', cwd, prepare }
  if (!(await orcaUp())) return { launched: false, reason: 'orca_down', cwd, prepare }
  if (Date.now() - num(c.store.get('sessions:orca_up_since')) < timing.launchGapMs) {
    return { launched: false, reason: 'orca_settling', cwd, prepare }
  }

  // The lock goes first: from here on a session may come up.
  const now = Date.now()
  c.store.set(k(name, 'launch_at'), now)

  // One session per topic, also across Orca restarts. "Shim not connected" is
  // not "Claude dead": the link from the session machine to the broker can be
  // down while Claude works. So a live Claude holding the key means alive —
  // nothing is closed or relaunched (that would kill its work and, after a
  // failed resume, its conversation); only the census proving no live Claude
  // (or "unknown" with no unrecognised terminals) allows a launch. The
  // exception is a reopened topic: closing unbound its shim for good, so our
  // own terminal is replaced (with --resume).
  const force = c.store.get(k(name, 'force_relaunch')) === '1'
  const cen = await census(name, cwd)
  let kp = await keyProcesses(row.key)
  if (kp.othersTotal) c.log('key_holders_ignored', { topic: name, count: kp.othersTotal, procs: procsField(kp.others) })
  if (!force && kp.n !== null && kp.n > 0) {
    // It runs: whatever this launch was, it was not a failure to come up.
    c.store.set(k(name, 'fails'), 0)
    // Pids and comms only (never the key) — enough for the owner to find them.
    c.log('session_alive_unreachable', { topic: name, ours: cen.ours.length, others: cen.others, claude_pids: procsField(kp.claude) })
    const healed = c.config.heal ? await heal(name, cen, kp) : false
    if (healed) return { launched: false, reason: 'healed', cwd, prepare }
    if (cen.ours.length) aliveNotice(name, cwd)
    else blockedNotice(name, cwd, true)
    return { launched: false, reason: cen.ours.length ? 'alive_unreachable' : 'blocked_alive', cwd, prepare }
  }
  if (cen.ours.length) await closeTerminals(name, cen.ours)
  // Our closed claude needs a moment to exit; poll instead of guessing.
  for (const end = Date.now() + timing.closeSettleMs; cen.ours.length && kp.n !== null && kp.n > 0 && Date.now() < end;) {
    await new Promise(r => setTimeout(r, 500))
    kp = await keyProcesses(row.key)
  }
  const alive = kp.n
  const safe = alive === 0 || (alive === null && cen.listOk && cen.others === 0)
  if (!safe) {
    const isAlive = alive !== null && alive > 0
    c.log('launch_blocked', {
      topic: name, alive, list_ok: cen.listOk, ours: cen.ours.length, others: cen.others, claude_pids: procsField(kp.claude),
    })
    // The claude we just closed may still be exiting: say nothing this time —
    // the next attempt (one launch gap later) reports if it is still there.
    if (isAlive && cen.ours.length) c.log('launch_deferred', { topic: name })
    else blockedNotice(name, cwd, isAlive)
    return { launched: false, reason: isAlive ? 'blocked_alive' : 'blocked_unknown', cwd, prepare }
  }
  if (force) c.log('relaunch_after_reopen', { topic: name, closed: cen.ours.length })

  const fails = num(c.store.get(k(name, 'fails')))
  c.store.set(k(name, 'fails'), fails + 1)

  await ensureRepo(name, cwd)

  const sid = row.session_id && SESSION_ID_RE.test(row.session_id) ? row.session_id : ''
  // An unknown root makes the trust check fail closed ("" is no folder's parent).
  const root = await projectsRoot().catch(() => '')
  const pre = await runOnSessionHost(['python3', '-c', SESSION_PY, 'prelaunch', cwd, root, sid], {
    timeoutMs: CMD_TIMEOUT_MS, label: 'prelaunch',
  })
  const pj = parseJson(pre.stdout) ?? {}
  c.log('prelaunch', { topic: name, trust: String(pj.trust ?? '-'), bypass_prompt: String(pj.bypass_prompt ?? '-'), resume: pj.resume ?? null, code: pre.code })
  let resume = !!sid && pj.resume === true
  // The previous launch resumed and never came up: the transcript may be what
  // breaks it, so start fresh rather than loop on it.
  if (resume && fails >= 1 && c.store.get(k(name, 'launch_resume')) === '1') {
    resume = false
    c.log('resume_dropped', { topic: name, fails })
  }
  if (sid && !resume) c.log('launch_fresh', { topic: name, had_session_id: true })

  const cmd = `CCSB_KEY=${row.key} ${c.config.claude_cmd}${resume ? ` --resume ${sid}` : ''}`
  const repoId = repoIdFor(parseJson((await orca(['repo', 'list', '--json'], 'orca_repo_list')).stdout), cwd)
  if (!repoId) c.log('repo_id_missing', { topic: name })
  const where = repoId ? `id:${repoId}::${cwd}` : `path:${cwd}`
  const r = await orca(['terminal', 'create', '--worktree', where, '--title', `tg:${name}`, '--command', cmd, '--json'], 'orca_terminal_create')
  const j = parseJson(r.stdout)
  if (r.code !== 0 || j === undefined || j?.ok === false) {
    const err = orcaError(r, row.key)
    c.log('launch_failed', { topic: name, err })
    return { launched: false, reason: 'create_failed', cwd, prepare, error: err }
  }
  const term = j?.result?.terminal ?? j?.terminal ?? j?.result ?? j
  const handle = typeof term?.handle === 'string' ? term.handle : undefined
  let tabId = typeof term?.tabId === 'string' ? term.tabId : undefined
  if (handle && !tabId) {
    // The create result may not carry the tab id; the list does.
    const lr = await orca(['terminal', 'list', '--json'], 'orca_terminal_list')
    const found = terminalsOf(parseJson(lr.stdout)).find(x => x?.handle === handle)
    if (typeof found?.tabId === 'string') tabId = found.tabId
  }
  if (handle || tabId) remember(name, { ...(handle ? { handle } : {}), ...(tabId ? { tabId } : {}) })
  c.store.del(k(name, 'handle'))
  if (!handle) c.log('terminal_create_shape', { topic: name, keys: Object.keys(term ?? {}).join(',') })
  c.store.del(k(name, 'force_relaunch'))
  c.store.set(k(name, 'launch_resume'), resume ? 1 : 0)
  c.store.set(k(name, 'sid_pending'), now)
  if (c.store.get(k(name, 'state')) !== 'down') c.store.set(k(name, 'state'), 'starting')
  c.log('launched', { topic: name, resume, has_handle: !!handle, has_tab: !!tabId })
  return { launched: true, reason: 'launched', cwd, prepare }
}

/** config.projects_root expanded against the session user's home. */
async function projectsRoot(): Promise<string> {
  const root = expandHome(ctx().config.projects_root, await sessionHome()).replace(/\/+$/, '')
  if (!root.startsWith('/')) throw new Error(`projects_root must be absolute or start with ~/ (${root})`)
  return root
}

// ---- watchdog -----------------------------------------------------------------------

async function discoverSessionId(name: string, cwd: string, since: number): Promise<void> {
  const c = ctx()
  const r = await runOnSessionHost(['python3', '-c', SESSION_PY, 'discover', cwd, '', String(since)], {
    timeoutMs: CMD_TIMEOUT_MS, label: 'discover_session',
  })
  const j = parseJson(r.stdout)
  const sid = j?.session_id
  if (typeof sid === 'string' && SESSION_ID_RE.test(sid)) {
    c.store.updateTopic(name, { session_id: sid })
    c.store.del(k(name, 'sid_pending'))
    c.log('session_id', { topic: name, found: true })
  } else if (r.code !== 0) {
    c.log('session_id', { topic: name, found: false, code: r.code })
  }
  // Not found yet: Claude writes the transcript with the first exchange; the
  // next tick looks again.
}

function notice(name: string, kind: 'down' | 'up'): void {
  const c = ctx()
  const key = k(name, `${kind}_notice_at`)
  if (Date.now() - num(c.store.get(key)) < timing.noticeGapMs) return
  c.store.set(key, Date.now())
  void c.notifyGeneral(t(c.config.lang, kind === 'down' ? 'session_down' : 'session_up', { name }))
}

export async function watchdogTick(): Promise<void> {
  const c = ctx()
  if (ticking || !c.isLocked()) return
  ticking = true
  try {
    for (const row of c.store.topics()) {
      if (row.state !== 'open') continue
      const name = row.name
      const now = Date.now()
      if (c.isConnected(name)) {
        lastSeen.set(name, now)
        const st = c.store.get(k(name, 'state'))
        if (st !== 'up') {
          if (st === 'down' || st === 'unreachable') notice(name, 'up')
          c.store.set(k(name, 'state'), 'up')
          c.log('session_up', { topic: name, since: c.connectedSince(name) })
        }
        c.store.set(k(name, 'fails'), 0)
        c.store.del(k(name, 'heal'))
        const pending = num(c.store.get(k(name, 'sid_pending')))
        if (pending && row.cwd) await discoverSessionId(name, row.cwd, pending)
        continue
      }
      const ref = Math.max(
        num(c.store.get(k(name, 'launch_at'))),
        num(c.store.get(k(name, 'created_at'))),
        lastSeen.get(name) ?? 0,
        startedAt + timing.startGraceMs - timing.launchGapMs,
      )
      if (now - ref < timing.launchGapMs) continue
      const res = await ensure(name)
      if (!res.launched) c.log('ensure_skipped', { topic: name, reason: res.reason })
      // These say nothing about the session's health (a launch just happened,
      // it reconnected meanwhile, the topic went away): no state change.
      if (['recent_launch', 'connected', 'closed', 'unknown_topic', 'not_configured', 'healed'].includes(res.reason)) continue
      // Alive but cut off from the broker is not "down": ensure already told
      // the owner which it is.
      const st = res.reason === 'alive_unreachable' ? 'unreachable' : 'down'
      if (c.store.get(k(name, 'state')) !== st) {
        c.store.set(k(name, 'state'), st)
        c.log(st === 'down' ? 'session_down' : 'session_unreachable', { topic: name })
        if (st === 'down') notice(name, 'down')
      }
    }
  } catch (e) {
    c.log('tick_failed', { err: e instanceof Error ? e.message : String(e) })
  } finally {
    ticking = false
  }
}

export const sessionsModule: BrokerModule = {
  name: 'sessions',
  start(c) {
    ctxRef = c
    initRunner(c.config)
    startedAt = Date.now()
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = setInterval(() => void watchdogTick(), timing.tickMs)
    // A module has no stop hook; do not keep a stopping broker alive.
    tickTimer.unref?.()
  },
  onUpdate(u) {
    if (!u.callback_query?.data?.startsWith('ccsr:')) return false
    // Off the poll loop: a restart can wait behind a heal and a launch, and
    // every other update would wait with it.
    void onRestartCallback(u.callback_query).catch(e => ctx().log('restart_failed', { err: e instanceof Error ? e.message : String(e) }))
    return true
  },
  async onLocked(c) {
    ctxRef ??= c
    const res = await ensure('general')
    c.log('general_ensure', { launched: res.launched, reason: res.reason, ...(res.error ? { err: res.error.slice(0, 200) } : {}) })
  },
}
// === GRACE END_BLOCK: broker_sessions =========================================
