import { afterEach, beforeEach, expect, test } from 'bun:test'
import { reactionTarget } from '../src/broker.ts'
import { ensureTopic, fakeShim, sleep, startServer, type TestServer } from './helpers.ts'

const owner = { owner_id: 42, chat_id: -100123 }

test('group event → owner chat, message id as is', () => {
  expect(reactionTarget(10, 555, owner)).toEqual({ chat: -100123, id: 555 })
})

test('private-chat event (negative message id) → owner_id, id negated back', () => {
  expect(reactionTarget(11, -77, owner)).toEqual({ chat: 42, id: 77 })
})

test('local event (negative update_id) → no reaction', () => {
  expect(reactionTarget(-3, 555, owner)).toBeNull()
})

let s: TestServer
const acks: [string, number][] = []
beforeEach(async () => {
  acks.length = 0
  s = await startServer({ deps: { onAck: (t, u) => acks.push([t, u]) } })
})
afterEach(() => s.close())

test('onAck fires on the first ack only', async () => {
  const key = ensureTopic(s.store)
  const a = await fakeShim(s.addr, { key, instance: 'A', caps: ['ping', 'redelivery'] })
  await a.next('welcome')
  const ev = s.store.enqueueLocal({ topic: 'wms', message_id: 5, user: 'o', user_id: '1', ts: '', text: 'x' })
  s.server.push(ev)
  await a.next('event')
  a.send({ t: 'ack', update_id: ev.update_id })
  a.send({ t: 'ack', update_id: ev.update_id })
  await sleep(100)
  expect(acks).toEqual([['wms', ev.update_id]])
  a.close()
})
