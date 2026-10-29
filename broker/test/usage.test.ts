import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { claudeLimits } from '../../usage/usage-poll.ts'
import { tempDir } from './helpers.ts'

const SH = join(import.meta.dir, '..', '..', 'usage', 'statusline.sh')
const future = Math.floor(Date.now() / 1000) + 3600
const past = Math.floor(Date.now() / 1000) - 60

test('claudeLimits: status line windows → usage.json windows, ts from the snapshot', () => {
  const raw = JSON.stringify({ ts: 1_800_000_000, rate_limits: {
    five_hour: { used_percentage: 41, resets_at: future },
    seven_day: { used_percentage: 58.5, resets_at: future },
  } })
  const u = claudeLimits(raw)
  expect(u.error).toBeUndefined()
  expect(u.ts).toBe(new Date(1_800_000_000_000).toISOString())
  expect(u.five_hour).toEqual({ pct: 41, resets_at: new Date(future * 1000).toISOString() })
  expect(u.week?.pct).toBe(58.5)
})

test('claudeLimits: a window whose reset passed reads 0 %, a missing one is null', () => {
  const u = claudeLimits(JSON.stringify({ ts: 1, rate_limits: { five_hour: { used_percentage: 90, resets_at: past } } }))
  expect(u.five_hour).toEqual({ pct: 0, resets_at: null })
  expect(u.week).toBeNull()
})

test('claudeLimits: no file, broken JSON, no windows → error and nulls, never numbers', () => {
  expect(claudeLimits(null)).toMatchObject({ five_hour: null, week: null, error: 'no_statusline' })
  expect(claudeLimits('{oops')).toMatchObject({ five_hour: null, week: null, error: 'bad_statusline' })
  expect(claudeLimits(JSON.stringify({ rate_limits: {} }))).toMatchObject({ error: 'bad_statusline' })
  expect(claudeLimits(JSON.stringify({ ts: 1, rate_limits: {} }))).toMatchObject({ five_hour: null, week: null, error: 'no_windows' })
})

function runStatusline(home: string, payload: string, next = 'cat'): { out: string; code: number } {
  const p = Bun.spawnSync(['/bin/sh', SH], {
    stdin: new TextEncoder().encode(payload),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CCSB_STATUSLINE_NEXT: next },
  })
  return { out: p.stdout.toString(), code: p.exitCode ?? -1 }
}

test.skipIf(!Bun.which('jq'))('statusline.sh: keeps only rate_limits, 0600, and passes the payload on', () => {
  const t = tempDir()
  const home = t.dir
  const payload = JSON.stringify({ session_id: 's', cwd: '/x', rate_limits: { five_hour: { used_percentage: 7, resets_at: future } } })
  const r = runStatusline(home, payload)
  expect(r.code).toBe(0)
  expect(r.out).toBe(payload)
  const f = join(home, '.local/state/ccswitchboard/statusline.json')
  const j = JSON.parse(readFileSync(f, 'utf8'))
  expect(Object.keys(j).sort()).toEqual(['rate_limits', 'ts'])
  expect(j.rate_limits.five_hour.used_percentage).toBe(7)
  expect(statSync(f).mode & 0o777).toBe(0o600)
  t.rm()
})

test('statusline.sh: a payload without rate_limits leaves the file alone', () => {
  const t = tempDir()
  const home = t.dir
  const r = runStatusline(home, JSON.stringify({ session_id: 's' }), 'true')
  expect(r.code).toBe(0)
  expect(existsSync(join(home, '.local/state/ccswitchboard/statusline.json'))).toBe(false)
  t.rm()
})
