import { afterEach, beforeEach, expect, test } from 'bun:test'
import { serverTiming } from '../src/server.ts'
import { ensureTopic, fakeShim, sleep, startServer, type TestServer } from './helpers.ts'

let s: TestServer
let key: string
const caps = ['ping', 'redelivery'] as const

beforeEach(async () => {
  serverTiming.pingWaitMs = 300
  s = await startServer()
  key = ensureTopic(s.store)
})
afterEach(() => s.close())

test('second hello while first answers ping → second rejected, first still bound', async () => {
  const refused: string[] = []
  s.close()
  s = await startServer({ deps: { onTakeoverRefused: t => refused.push(t) } })
  key = ensureTopic(s.store)
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  const r = await b.next('reject')
  expect(r.reason).toMatch(/held by a live session/)
  expect(refused).toEqual(['wms'])
  expect(s.server.connectedTopics()).toEqual(['wms'])
  expect(a.msgs.some(m => m.t === 'unbound')).toBe(false)
  a.close()
  b.close()
})

test('second hello while first ignores ping → first unbound, second welcomed', async () => {
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }, { answerPings: false })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await b.next('welcome', 2000)
  expect((await a.next('unbound')).reason).toMatch(/did not answer ping/)
  a.close()
  b.close()
})

test('first without caps → replaced without a ping (old behaviour)', async () => {
  const a = await fakeShim(s.addr, { key })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await b.next('welcome')
  await a.next('unbound')
  expect(a.msgs.some(m => m.t === 'ping')).toBe(false)
  a.close()
  b.close()
})

test('two hellos at once for one topic → exactly one bound', async () => {
  const [a, b] = await Promise.all([
    fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }),
    fakeShim(s.addr, { key, instance: 'b', caps: [...caps] }),
  ])
  await sleep(200)
  const welcomed = [a, b].filter(x => x.msgs.some(m => m.t === 'welcome'))
  const rejected = [a, b].filter(x => x.msgs.some(m => m.t === 'reject'))
  expect(welcomed.length).toBe(1)
  expect(rejected.length).toBe(1)
  a.close()
  b.close()
})

test('a pong with a wrong nonce does not count', async () => {
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }, { answerPings: false })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await a.next('ping')
  a.send({ t: 'pong', nonce: 'not-the-one' })
  await b.next('welcome', 2000)
  a.close()
  b.close()
})

test('old socket closes during the wait → new one is welcomed', async () => {
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }, { answerPings: false })
  await a.next('welcome')
  serverTiming.pingWaitMs = 5000
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await a.next('ping')
  a.close()
  await b.next('welcome', 1000)
  b.close()
})

test('a hung holder is dropped even when the newcomer gave up during the wait', async () => {
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }, { answerPings: false })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await a.next('ping')
  b.close()
  await a.next('unbound', 2000)
  expect(s.server.connectedTopics()).toEqual([])
  const c = await fakeShim(s.addr, { key, instance: 'c', caps: [...caps] })
  await c.next('welcome', 1000)
  a.close()
  c.close()
})

test('topic closed during the ping wait → the newcomer is rejected', async () => {
  const a = await fakeShim(s.addr, { key, instance: 'a', caps: [...caps] }, { answerPings: false })
  await a.next('welcome')
  const b = await fakeShim(s.addr, { key, instance: 'b', caps: [...caps] })
  await a.next('ping')
  s.store.setTopicState('wms', 'closed')
  expect((await b.next('reject', 2000)).reason).toMatch(/closed/)
  a.close()
  b.close()
})
