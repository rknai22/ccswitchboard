// === GRACE START_BLOCK: broker_heal ===========================================
// MODULE_CONTRACT:
//   IN:  heal state of a topic (kv JSON), Orca's terminal handle of the
//        topic's only live Claude, `orca repo list --json` output.
//   OUT: healDecision() — wait / heal / ask the owner; HEAL_PY — the
//        /mcp → ccswitchboard → Reconnect keystrokes, run on the session
//        machine (one round trip); repoIdFor() — the Orca project id of a
//        folder.
//   INV: keys go only into an idle-looking session, and the screen is read
//        again before every keystroke: if it stopped being what the step
//        expects, the helper backs out and reports "changed".
//   INV: the helper prints JSON {ok, why} only — never screen text (the
//        launch command on screen carries the topic key).
//   INV: nothing here closes a terminal; after maxFails heals in a row the
//        owner is asked (a button) once — again only after the topic was
//        connected in between (the watchdog then clears the state).
//   INV: a shim process that is alive but has no link to the broker is a
//        network problem, not a dead plugin: nothing is typed ("shim_alive").

export const healTiming = {
  strikes: 2,
  minClaudeAgeS: 120,
  cooldownMs: 300_000,
  maxFails: 3,
  /** after the keystrokes, how long to wait for the shim to come back */
  connectWaitMs: 20_000,
}

export type HealState = { strikes: number; lastAt: number; fails: number; askedAt: number }

export const emptyHeal = (): HealState => ({ strikes: 0, lastAt: 0, fails: 0, askedAt: 0 })

export function parseHeal(v: string | undefined): HealState {
  try {
    const j = JSON.parse(v ?? '')
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    return { strikes: n(j?.strikes), lastAt: n(j?.lastAt), fails: n(j?.fails), askedAt: n(j?.askedAt) }
  } catch {
    return emptyHeal()
  }
}

/** One more miss has been counted in s.strikes already. claudeAgeS null =
 *  unknown (no /proc): treated as old enough. */
export function healDecision(s: HealState, claudeAgeS: number | null, now: number): 'wait' | 'heal' | 'ask_owner' {
  if (s.fails >= healTiming.maxFails) return s.askedAt ? 'wait' : 'ask_owner'
  if (s.strikes < healTiming.strikes) return 'wait'
  if (claudeAgeS !== null && claudeAgeS < healTiming.minClaudeAgeS) return 'wait'
  if (now - s.lastAt < healTiming.cooldownMs) return 'wait'
  return 'heal'
}

const normPath = (p: unknown) => (typeof p === 'string' ? p.replace(/\/+$/, '') : '')

/** Orca's id of the project registered at `path`. */
export function repoIdFor(repoList: unknown, path: string): string | undefined {
  const j = repoList as any
  const repos = j?.result?.repos ?? j?.repos ?? (Array.isArray(j) ? j : [])
  if (!Array.isArray(repos)) return undefined
  const hit = repos.find(r => normPath(r?.path) === normPath(path) && typeof r?.id === 'string')
  return hit?.id
}

// The keystrokes of ~/bin/ccsb-mcp-heal.py (tested there on Claude Code's /mcp
// menu), with a screen check before each key. argv: orca binary, handle,
// claude pid. Before typing: a live shim under that claude with no TCP link
// to the broker means the network is down — "shim_alive", nothing typed. (A
// shim linked to the broker but not bound to the topic — unbound after a
// takeover — is healed: only a new shim process brings the key back.)
export const HEAL_PY = String.raw`
import json, os, re, subprocess, sys, time
orca, handle, claude_pid = sys.argv[1:4]
BUSY = re.compile(r'…\s*\(\d')
def done(ok, why):
    print(json.dumps({"ok": ok, "why": why})); sys.exit(0)
def run(*a):
    r = subprocess.run([orca, *a], capture_output=True, text=True, timeout=20)
    return r.returncode, r.stdout
def screen():
    code, out = run("terminal", "read", "--terminal", handle, "--screen")
    return [l.rstrip() for l in out.splitlines()] if code == 0 else None
def send(text, enter=False):
    run("terminal", "send", "--terminal", handle, "--text", text, *(["--enter"] if enter else []))
def idle(lines):
    body = [l for l in lines if l.strip()]
    if any(BUSY.search(l) for l in body[-12:]): return False
    for i in range(len(body) - 2, 0, -1):
        if body[i].strip() == "❯":
            return body[i - 1].lstrip().startswith("─") and body[i + 1].lstrip().startswith("─")
    return False
def selected(lines):
    for l in reversed(lines):
        if "❯" in l and l.strip() != "❯": return l
    return ""
def back_out():
    for _ in range(3):
        s = screen() or []
        if idle(s) or any(BUSY.search(l) for l in s): break
        send("\x1b"); time.sleep(0.7)
def guard(cond, why):
    s = screen() or []
    if not cond(s):
        back_out(); done(False, why)
    return s
def kids():
    out = {}
    for p in os.listdir("/proc"):
        if not p.isdigit(): continue
        try:
            ppid = int(open("/proc/%s/stat" % p).read().rsplit(")", 1)[1].split()[1])
        except Exception:
            continue
        out.setdefault(ppid, []).append(int(p))
    return out
def shims(pid):
    k, todo, found = kids(), [pid], []
    while todo:
        for c in k.get(todo.pop(), []):
            todo.append(c)
            try:
                cmd = open("/proc/%d/cmdline" % c, "rb").read().split(b"\0")
            except Exception:
                continue
            if any(a.endswith(b"server.ts") for a in cmd): found.append(c)
    return found
def broker_addr():
    try:
        for l in open(os.path.expanduser("~/.config/ccswitchboard/env")):
            if l.startswith("CCSB_BROKER="):
                return l.split("=", 1)[1].strip()
    except Exception:
        pass
    return None
def linked(pids, addr):
    if not addr or not pids: return False
    r = subprocess.run(["ss", "-tnpH", "state", "established", "dst", addr], capture_output=True, text=True)
    return any("pid=%d," % p in r.stdout for p in pids)
if os.path.isdir("/proc") and claude_pid.isdigit():
    alive = shims(int(claude_pid))
    if alive and not linked(alive, broker_addr()): done(False, "shim_alive")
s = screen()
if s is None: done(False, "no_screen")
if any("Manage MCP servers" in l for l in s):
    # A menu left open by an interrupted heal: close it first.
    back_out()
    s = screen() or []
if not idle(s): done(False, "busy")
s = guard(idle, "changed")
send("/mcp", enter=True); time.sleep(3)
in_menu = lambda s: any("Manage MCP servers" in l for l in s)
s = guard(in_menu, "no_menu")
for _ in range(40):
    if "ccswitchboard" in selected(s): break
    s = guard(in_menu, "changed")
    send("\x1b[B"); time.sleep(0.4)
    s = screen() or []
else:
    back_out(); done(False, "no_server")
s = guard(lambda s: "ccswitchboard" in selected(s), "changed")
send("\r"); time.sleep(2)
s = screen() or []
for _ in range(4):
    if "Reconnect" in selected(s): break
    s = guard(lambda s: not idle(s), "changed")
    send("\x1b[B"); time.sleep(0.4)
    s = screen() or []
else:
    back_out(); done(False, "no_reconnect")
guard(lambda s: "Reconnect" in selected(s), "changed")
send("\r")
done(True, "sent")
`
// === GRACE END_BLOCK: broker_heal =============================================
