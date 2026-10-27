import { afterEach, beforeEach, expect, test } from 'bun:test'
import { serverTiming } from '../src/server.ts'
import { ensureTopic, fakeShim, sleep, startServer, tempDir, type TestServer } from './helpers.ts'

let s: TestServer
let key: string
const caps = ['ping', 'redelivery'] as const

beforeEach(async () => {
  serverTiming.pingWaitMs = 300
  serverTiming.redeliverWindowMs = 30 * 60_000
  s = await startServer()
  key = ensureTopic(s.store)
})
afterEach(() => s.close())

function queue(id: number) {
  const ev = s.store.enqueueLocal({ topic: 'wms', message_id: id, user: 'o', user_id: '1', ts: new Date().toISOString(), text: `m${id}` })
  s.server.push(ev)
  return ev
}

async function deliverTo(instance: string) {
  const a = await fakeShim(s.addr, { key, instance, caps: [...caps] })
  await a.next('welcome')
  return a
}

test('acked by A, A goes away, B connects → B gets it again, marked redelivered', async () => {
  const a = await deliverTo('A')
  const ev = queue(1)
  const got = await a.next('event')
  a.send({ t: 'ack', update_id: got.update_id })
  await sleep(50)
  a.close()
  await sleep(50)
  const b = await fakeShim(s.addr, { key, instance: 'B', caps: [...caps] })
  await b.next('welcome')
  const again = await b.next('event')
  expect(again.update_id).toBe(ev.update_id)
  expect(again.redelivered).toBe(true)
  b.close()
})

test('redeliveries (older) first, then the backlog', async () => {
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(50)
  a.close()
  await sleep(50)
  queue(2)
  const b = await fakeShim(s.addr, { key, instance: 'B', caps: [...caps] })
  await b.next('welcome')
  const first = await b.next('event')
  const second = await b.next('event')
  expect(first.text).toBe('m1')
  expect(first.redelivered).toBe(true)
  expect(second.text).toBe('m2')
  expect(second.redelivered).toBeUndefined()
  b.close()
})

test('the same instance reconnecting gets no redelivery', async () => {
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(50)
  a.close()
  await sleep(50)
  const a2 = await fakeShim(s.addr, { key, instance: 'A', caps: [...caps] })
  await a2.next('welcome')
  await sleep(100)
  expect(a2.msgs.some(m => m.t === 'event')).toBe(false)
  a2.close()
})

test('acked longer than the window before A went away → not redelivered', async () => {
  serverTiming.redeliverWindowMs = 100
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(250)
  a.close()
  await sleep(50)
  const b = await deliverTo('B')
  await sleep(100)
  expect(b.msgs.some(m => m.t === 'event')).toBe(false)
  b.close()
})

test('a shim without caps redelivery gets no redelivery', async () => {
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(50)
  a.close()
  await sleep(50)
  const old = await fakeShim(s.addr, { key })
  await old.next('welcome')
  await sleep(100)
  expect(old.msgs.some(m => m.t === 'event')).toBe(false)
  old.close()
})

test('broker restart between the ack and the new hello → still redelivered', async () => {
  const keep = tempDir()
  s.close()
  s = await startServer({ dir: keep.dir })
  key = ensureTopic(s.store)
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(50)
  // The broker dies without seeing A go: no instance_gone_at.
  s.server.close()
  s.store.close()
  a.close()
  s = await startServer({ dir: keep.dir })
  const b = await deliverTo('B')
  const again = await b.next('event')
  expect(again.redelivered).toBe(true)
  b.close()
  s.close()
  keep.rm()
  s = await startServer()
})

test('a repeated ack keeps the first delivered_at: the window does not slide', async () => {
  serverTiming.redeliverWindowMs = 300
  const a = await deliverTo('A')
  queue(1)
  a.send({ t: 'ack', update_id: (await a.next('event')).update_id })
  await sleep(50)
  a.close()
  await sleep(50)
  const b = await deliverTo('B')
  const again = await b.next('event')
  await sleep(250)
  b.send({ t: 'ack', update_id: again.update_id })
  await sleep(50)
  b.close()
  await sleep(50)
  const c = await deliverTo('C')
  await sleep(100)
  expect(c.msgs.some(m => m.t === 'event')).toBe(false)
  c.close()
})
