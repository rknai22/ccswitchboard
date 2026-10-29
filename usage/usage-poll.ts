#!/usr/bin/env bun
// === GRACE START_BLOCK: usage_poll ============================================
// MODULE_CONTRACT:
//   IN:  <in> (default ~/.local/state/ccswitchboard/statusline.json), written
//        by usage/statusline.sh from Claude Code's own status line:
//        {"ts": epoch s, "rate_limits": {"five_hour"?, "seven_day"?:
//        {"used_percentage", "resets_at": epoch s}}};
//        argv: [--out <file>] [--in <file>].
//   OUT: <out> (default ~/.local/state/ccswitchboard/usage.json), 0600,
//        replaced atomically:
//        {"ts": ISO, "five_hour": {"pct", "resets_at"} | null,
//         "week": {"pct", "resets_at"} | null, "error"?: string}
//        Exit 0 when the file was written (even with an error inside it),
//        1 when it could not be written.
//   INV: no credentials, no network. The numbers are what Claude Code last
//        showed in a session's status line (Pro/Max only), so they move only
//        while some session works; ts is when they were seen, and the pin
//        calls them stale after 15 minutes.
//   INV: a window whose reset time has passed reads 0 % — nothing is used in
//        the new one yet.
//   INV: any failure writes nulls plus `error`, never the previous numbers —
//        stale numbers presented as current are worse than none.
//   OUT (also): "codex": {"five_hour", "week", "as_of"} | null — ChatGPT/Codex
//        limits as the Codex CLI last saw them: the newest rate_limits event in
//        ~/.codex/sessions/**/rollout-*.jsonl (what Orca shows too). Read-only;
//        as_of is that event's time, so old numbers look old.

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

type Window = { pct: number; resets_at: string | null }
type Codex = { five_hour: Window | null; week: Window | null; as_of: string | null }
type Out = { ts: string; five_hour: Window | null; week: Window | null; error?: string; codex?: Codex | null }

function log(ev: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), mod: 'usage', ev, ...fields }) + '\n')
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

function args(argv: string[]): { out: string; input: string } {
  let out = '~/.local/state/ccswitchboard/usage.json'
  let input = '~/.local/state/ccswitchboard/statusline.json'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') out = argv[++i] ?? out
    else if (a.startsWith('--out=')) out = a.slice(6)
    else if (a === '--in') input = argv[++i] ?? input
    else if (a.startsWith('--in=')) input = a.slice(5)
    else {
      process.stderr.write('usage: usage-poll.ts [--out <file>] [--in <statusline.json>]\n')
      process.exit(2)
    }
  }
  return { out: resolve(expandHome(out)), input: resolve(expandHome(input)) }
}

function window(v: unknown): Window | null {
  const w = v as Record<string, unknown> | null
  if (!w || typeof w !== 'object' || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  const r = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null
  if (r && Date.parse(r) <= Date.now()) return { pct: 0, resets_at: null }
  return { pct: w.used_percentage, resets_at: r }
}

/** statusline.json text → the Claude part of usage.json. Never throws. */
export function claudeLimits(raw: string | null): Omit<Out, 'codex'> {
  const none = (error: string) => ({ ts: new Date().toISOString(), five_hour: null, week: null, error })
  if (raw === null) return none('no_statusline')
  let j: unknown
  try { j = JSON.parse(raw) } catch { return none('bad_statusline') }
  const o = j as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return none('bad_statusline')
  const rl = o.rate_limits as Record<string, unknown> | null
  if (!rl || typeof rl !== 'object') return none('bad_statusline')
  const five_hour = window(rl.five_hour)
  const week = window(rl.seven_day)
  // Claude Code drops a window once its reset passes; absent means "reset since".
  const ts = new Date(o.ts * 1000).toISOString()
  if (!five_hour && !week) return { ts, five_hour: null, week: null, error: 'no_windows' }
  return { ts, five_hour, week }
}

/** Newest Codex rollout files first (by mtime), at most `n`. */
function rollouts(n: number): string[] {
  const root = join(homedir(), '.codex', 'sessions')
  const found: { p: string; m: number }[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      if (depth < 3) walk(p, depth + 1)
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        try { found.push({ p, m: statSync(p).mtimeMs }) } catch {}
      }
    }
  }
  walk(root, 0)
  return found.sort((a, b) => b.m - a.m).slice(0, n).map(x => x.p)
}

function tail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function codexWindow(v: unknown): { minutes: number; w: Window } | null {
  const o = v as Record<string, unknown> | null
  if (!o || typeof o.used_percent !== 'number' || typeof o.window_minutes !== 'number') return null
  const r = typeof o.resets_at === 'number' ? new Date(o.resets_at * 1000).toISOString() : null
  // The window reset since Codex last saw it: nothing used in the new one yet.
  if (r && Date.parse(r) <= Date.now()) return { minutes: o.window_minutes, w: { pct: 0, resets_at: null } }
  return { minutes: o.window_minutes, w: { pct: o.used_percent, resets_at: r } }
}

export function codexLimits(): Codex | null {
  for (const p of rollouts(5)) {
    let text: string
    try { text = tail(p, 512 * 1024) } catch { continue }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.includes('"rate_limits"')) continue
      try {
        const j = JSON.parse(lines[i]!)
        const rl = j?.payload?.rate_limits
        const ws = [codexWindow(rl?.primary), codexWindow(rl?.secondary)].filter(Boolean) as { minutes: number; w: Window }[]
        if (!ws.length) continue
        const pick = (lo: number, hi: number) => ws.find(x => x.minutes >= lo && x.minutes <= hi)?.w ?? null
        const ts = typeof j?.timestamp === 'string' && !Number.isNaN(Date.parse(j.timestamp)) ? new Date(j.timestamp).toISOString() : null
        return { five_hour: pick(60, 720), week: pick(721, 20160), as_of: ts }
      } catch {}
    }
  }
  return null
}

function writeAtomic(path: string, data: Out): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

if (import.meta.main) {
  const { out, input } = args(process.argv.slice(2))
  let raw: string | null = null
  try { raw = readFileSync(input, 'utf8') } catch {}
  // ts is when the numbers were seen, so the pin's "data as of" is honest.
  const claude = claudeLimits(raw)
  let codex: Codex | null = null
  try { codex = codexLimits() } catch {}
  const result: Out = { ...claude, codex }
  try {
    writeAtomic(out, result)
    log('written', { error: result.error ?? null, five_hour: result.five_hour !== null, week: result.week !== null, codex: codex !== null })
  } catch (e) {
    log('write_failed', { err: (e as Error)?.message ?? String(e) })
    process.exit(1)
  }
}
// === GRACE END_BLOCK: usage_poll ==============================================
