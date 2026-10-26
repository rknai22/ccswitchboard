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
//   INV: one Claude per topic across Orca restarts: a terminal is closed only
//        when its handle or tabId is in the topic's launch history, and a
//        launch is skipped (owner told) while a process with the topic's key
//        lives outside the terminals we can prove — or, when processes cannot
//        be counted, while unrecognised terminals sit in the topic folder.
//        After Orca comes back, launches wait launchGapMs for restored shims.
//   INV: closed topics are never (re)started; folders are never deleted.
//   INV: a folder is trusted (~/.claude.json) only when it sits directly in
//        projects_root — the broker never vouches for folders it did not make.
//   INV: all session-machine commands go through runOnSessionHost as argv; the
//        topic key appears only inside the terminal command (accepted by the
//        spec: topics are not isolated from each other), never in logs.

import { readFileSync } from 'fs'
import type { BrokerContext, BrokerModule } from './context.ts'
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
}

async function census(name: string, cwd: string): Promise<Census> {
  const c = ctx()
  const r = await orca(['terminal', 'list', '--json'], 'orca_terminal_list')
  const j = parseJson(r.stdout)
  if (r.code !== 0 || j === undefined || j?.ok === false) {
    c.log('terminal_list_failed', { topic: name, err: orcaError(r) })
    return { listOk: false, ours: [], others: 0 }
  }
  if (!Array.isArray(j?.result?.terminals)) c.log('terminal_list_shape', { keys: Object.keys(j ?? {}).join(',') })
  const hist = history(name)
  const handles = new Set(hist.map(x => x.handle).filter(Boolean))
  const tabs = new Set(hist.map(x => x.tabId).filter(Boolean))
  const out: Census = { listOk: true, ours: [], others: 0 }
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

// Live processes on the session machine whose environment holds
// CCSB_KEY=<key> (the key comes on stdin, never in argv). Linux: /proc, where
// a same-user process's environ is readable — a real count, 0 included.
// Elsewhere `ps -E` (BSD/macOS) shows the environment of only some processes
// (not of hardened binaries), so it can prove presence but never absence:
// a positive count, otherwise "unknown".
const KEYPROC_PY = String.raw`
import os, subprocess, sys
mark = ("CCSB_KEY=" + sys.stdin.read().strip()).encode()
me = os.getpid()
n = 0
if os.path.isdir("/proc/self"):
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) == me: continue
        try:
            env = open("/proc/%s/environ" % p, "rb").read()
        except Exception:
            continue
        if mark in env.split(b"\0"): n += 1
    print(n)
else:
    r = subprocess.run(["ps", "-E", "-ww", "-o", "pid=,command=", "-U", str(os.getuid())], capture_output=True)
    if r.returncode != 0:
        print("unknown"); sys.exit(0)
    for line in r.stdout.split(b"\n"):
        parts = line.split()
        if len(parts) < 2 or parts[0] == str(me).encode(): continue
        if mark in parts[1:]: n += 1
    print(n if n > 0 else "unknown")
`

/** Number of live processes carrying the topic's key, or null when unknown. */
async function keyProcesses(key: string): Promise<number | null> {
  const r = await runOnSessionHost(['python3', '-c', KEYPROC_PY], { input: key, timeoutMs: CMD_TIMEOUT_MS, label: 'key_processes' })
  const n = Number(r.stdout.trim())
  return r.code === 0 && r.stdout.trim() !== '' && Number.isInteger(n) ? n : null
}

/** Close the topic's own terminals (proved by launch history) — used when the
 *  topic is deleted, before its kv (and so the history) is wiped. Terminals we
 *  cannot prove are ours are left alone. */
export async function closeTopicTerminals(name: string): Promise<{ closed: number; others: number; alive: number | null }> {
  const c = ctx()
  const row = c.store.topic(name)
  if (!row?.cwd) return { closed: 0, others: 0, alive: null }
  const cen = await census(name, row.cwd)
  const closed = await closeTerminals(name, cen.ours)
  const alive = await keyProcesses(row.key)
  c.log('topic_terminals_closed', { topic: name, closed, others: cen.others, alive })
  return { closed, others: cen.others, alive }
}

function blockedNotice(name: string, cwd: string, alive: boolean): void {
  const c = ctx()
  const key = k(name, 'blocked_notice_at')
  if (Date.now() - num(c.store.get(key)) < timing.noticeGapMs) return
  c.store.set(key, Date.now())
  void c.notifyGeneral(t(c.config.lang, alive ? 'session_blocked_alive' : 'session_blocked_unknown', { name, cwd }))
}

// ---- ensure -------------------------------------------------------------------------

export type EnsureResult = {
  launched: boolean
  /** connected | recent_launch | closed | unknown_topic | not_configured |
   *  folder_failed | orca_down | orca_settling | blocked_alive |
   *  blocked_unknown | create_failed | launched */
  reason: string
  cwd?: string
  prepare?: PrepareResult
  error?: string
}

/** Make sure the topic has a folder and a live session; serialized per topic. */
export function ensure(name: string): Promise<EnsureResult> {
  const prev = chains.get(name) ?? Promise.resolve()
  const run = prev.then(() => ensureNow(name))
  chains.set(name, run.catch(() => {}))
  return run
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

  // One session per topic, also across Orca restarts: close what is provably
  // ours, then launch only if no process with this topic's key survives and
  // nothing unrecognised could be a restored copy of our session.
  const cen = await census(name, cwd)
  const aliveBefore = await keyProcesses(row.key)
  if (cen.ours.length) await closeTerminals(name, cen.ours)
  let alive = aliveBefore
  // Our closed claude needs a moment to exit; poll instead of guessing.
  for (const end = Date.now() + timing.closeSettleMs; cen.ours.length && alive !== null && alive > 0 && Date.now() < end;) {
    await new Promise(r => setTimeout(r, 500))
    alive = await keyProcesses(row.key)
  }
  const safe = alive === 0 || (alive === null && cen.listOk && cen.others === 0)
  if (!safe) {
    c.log('launch_blocked', { topic: name, alive, list_ok: cen.listOk, ours: cen.ours.length, others: cen.others })
    blockedNotice(name, cwd, alive !== null && alive > 0)
    return { launched: false, reason: alive !== null && alive > 0 ? 'blocked_alive' : 'blocked_unknown', cwd, prepare }
  }

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
  const r = await orca(['terminal', 'create', '--worktree', `path:${cwd}`, '--title', `tg:${name}`, '--command', cmd, '--json'], 'orca_terminal_create')
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
          if (st === 'down') notice(name, 'up')
          c.store.set(k(name, 'state'), 'up')
          c.log('session_up', { topic: name, since: c.connectedSince(name) })
        }
        c.store.set(k(name, 'fails'), 0)
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
      if (c.store.get(k(name, 'state')) !== 'down') {
        c.store.set(k(name, 'state'), 'down')
        c.log('session_down', { topic: name })
        notice(name, 'down')
      }
      const res = await ensure(name)
      if (!res.launched) c.log('ensure_skipped', { topic: name, reason: res.reason })
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
  async onLocked(c) {
    ctxRef ??= c
    const res = await ensure('general')
    c.log('general_ensure', { launched: res.launched, reason: res.reason, ...(res.error ? { err: res.error.slice(0, 200) } : {}) })
  },
}
// === GRACE END_BLOCK: broker_sessions =========================================
