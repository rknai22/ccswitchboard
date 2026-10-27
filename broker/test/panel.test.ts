import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { Broker, verifyInitData } from '../src/broker.ts'
import { handle } from '../src/panel.ts'
import { parseUsage, renderPin } from '../src/pin.ts'
import { tasksModule } from '../src/tasks.ts'
import { tempDir } from './helpers.ts'

const TOKEN = '123:abc'

function initData(user: number, authDate = Math.floor(Date.now() / 1000), token = TOKEN): string {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'q', user: JSON.stringify({ id: user, first_name: 'o' }) })
  const lines = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  p.set('hash', createHmac('sha256', secret).update(lines).digest('hex'))
  return p.toString()
}

test('verifyInitData: valid, forged, stale', () => {
  expect(verifyInitData(initData(42), TOKEN)).toBe(42)
  expect(verifyInitData(initData(42, undefined, '999:zzz'), TOKEN)).toBeNull()
  expect(verifyInitData(initData(42).replace('first_name', 'last_name'), TOKEN)).toBeNull()
  expect(verifyInitData(initData(42, Math.floor(Date.now() / 1000) - 2 * 86400), TOKEN)).toBeNull()
  expect(verifyInitData('garbage', TOKEN)).toBeNull()
})

let tmp: ReturnType<typeof tempDir>
let b: Broker
let ctx: any
beforeEach(async () => {
  tmp = tempDir()
  b = new Broker({ state_dir: tmp.dir, lang: 'en', api_root: '', listen: '127.0.0.1:1', timezone: 'UTC', usage_file: '/nonexistent', runner: [] } as any, [tasksModule])
  ;(b as any).sec = { bot_token: TOKEN, owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7, title: 'WMS <b>' })
  ctx = (b as any).ctxFor(tasksModule)
  await tasksModule.start!(ctx)
})
afterEach(() => {
  b.stop()
  tmp.rm()
})

const req = (path: string, init?: string, method = 'GET', body?: object) =>
  new Request(`http://x${path}`, { method, headers: init ? { 'x-telegram-init-data': init } : {}, body: body ? JSON.stringify(body) : undefined })

test('the page is public, the data is not', async () => {
  expect((await handle(req('/'), ctx)).status).toBe(200)
  expect((await handle(req('/api/state'), ctx)).status).toBe(401)
  expect((await handle(req('/api/state', initData(7)), ctx)).status).toBe(401)
})

test('the owner gets topics and tasks', async () => {
  await (b as any).handleTool('report', { title: 'T', state: 'in_progress', summary: 's' }, { id: 1, mode: 'topic', topic: 'wms' })
  const r = await handle(req('/api/state', initData(42)), ctx)
  expect(r.status).toBe(200)
  const s = await r.json() as any
  expect(s.topics[0].name).toBe('wms')
  expect(s.topics[0].tasks[0].title).toBe('T')
})

test('actions need the owner and an open topic', async () => {
  expect((await handle(req('/api/restart', initData(7), 'POST', { topic: 'wms' }), ctx)).status).toBe(401)
  expect((await handle(req('/api/restart', initData(42), 'POST', { topic: 'nope' }), ctx)).status).toBe(400)
})

test('usage file with codex limits → parsed and pinned', () => {
  const u = parseUsage(JSON.stringify({
    ts: '2026-10-28T00:00:00Z', five_hour: { pct: 9, resets_at: null }, week: { pct: 11, resets_at: null },
    codex: { five_hour: { pct: 3, resets_at: null }, week: { pct: 1, resets_at: null }, as_of: '2026-10-27T23:00:00Z' },
  }))
  expect(u.codex!.five_hour!.pct).toBe(3)
  const pin = renderPin({ lang: 'en', timezone: 'UTC' } as any, u, new Date('2026-10-28T00:01:00Z'))
  expect(pin).toContain('ChatGPT (Codex) limits')
})
