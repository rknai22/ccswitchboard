#!/usr/bin/env bun
// === GRACE START_BLOCK: usage_poll ============================================
// MODULE_CONTRACT:
//   IN:  ~/.claude/.credentials.json → claudeAiOauth.accessToken (the token
//        Claude Code itself signs in with); argv: [--out <file>] [--api <base>].
//   OUT: <out> (default ~/.local/state/ccswitchboard/usage.json), 0600,
//        replaced atomically:
//        {"ts": ISO, "five_hour": {"pct", "resets_at"} | null,
//         "week": {"pct", "resets_at"} | null, "error"?: string}
//        Exit 0 when the file was written (even with an error inside it),
//        1 when it could not be written.
//   INV: the same source as /usage (GET <api>/api/oauth/usage): it works on
//        Team accounts, where the status line gets no rate_limits. The
//        endpoint is undocumented — when it changes, the pin says "no data".
//   INV: the token is never refreshed here. A refresh rotates the refresh
//        token and would sign out the live sessions; on 401 the file says
//        "token_expired" and the next session start refreshes it.
//   INV: any failure writes nulls plus `error`, never the previous numbers —
//        stale numbers presented as current are worse than none.
//   INV: neither the token nor the response body is logged.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

const TIMEOUT_MS = 20_000

type Window = { pct: number; resets_at: string | null }
type Out = { ts: string; five_hour: Window | null; week: Window | null; error?: string }

function log(ev: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), mod: 'usage', ev, ...fields }) + '\n')
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

function args(argv: string[]): { out: string; api: string } {
  let out = '~/.local/state/ccswitchboard/usage.json'
  let api = 'https://api.anthropic.com'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') out = argv[++i] ?? out
    else if (a.startsWith('--out=')) out = a.slice(6)
    else if (a === '--api') api = argv[++i] ?? api
    else if (a.startsWith('--api=')) api = a.slice(6)
    else {
      process.stderr.write('usage: usage-poll.ts [--out <file>] [--api <base url>]\n')
      process.exit(2)
    }
  }
  return { out: resolve(expandHome(out)), api: api.replace(/\/+$/, '') }
}

function readToken(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
    const tok = j?.claudeAiOauth?.accessToken
    return typeof tok === 'string' && tok ? tok : null
  } catch {
    return null
  }
}

function window(v: unknown): Window | null {
  if (!v || typeof v !== 'object') return null
  const w = v as Record<string, unknown>
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null
  const r = typeof w.resets_at === 'string' && !Number.isNaN(new Date(w.resets_at).getTime())
    ? new Date(w.resets_at).toISOString()
    : null
  return { pct: w.utilization, resets_at: r }
}

async function poll(api: string): Promise<Omit<Out, 'ts'>> {
  const none = (error: string) => ({ five_hour: null, week: null, error })
  const token = readToken()
  if (!token) return none('no_credentials')
  let res: Response
  try {
    res = await fetch(`${api}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const name = (e as Error)?.name
    return none(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
  }
  log('http', { status: res.status })
  if (res.status === 401) return none('token_expired')
  if (!res.ok) return none(`http_${res.status}`)
  let j: unknown
  try {
    j = JSON.parse(await res.text())
  } catch (e) {
    const name = (e as Error)?.name
    return none(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'bad_response')
  }
  if (!j || typeof j !== 'object') return none('bad_response')
  const o = j as Record<string, unknown>
  const five_hour = window(o.five_hour)
  const week = window(o.seven_day)
  if (!five_hour && !week) return none('bad_response')
  return { five_hour, week }
}

function writeAtomic(path: string, data: Out): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

const { out, api } = args(process.argv.slice(2))
const polled = await poll(api)
// ts is when the numbers were read, so the pin's "data as of" is honest.
const result: Out = { ts: new Date().toISOString(), ...polled }
try {
  writeAtomic(out, result)
  log('written', { error: result.error ?? null, five_hour: result.five_hour !== null, week: result.week !== null })
} catch (e) {
  log('write_failed', { err: (e as Error)?.message ?? String(e) })
  process.exit(1)
}
// === GRACE END_BLOCK: usage_poll ==============================================
