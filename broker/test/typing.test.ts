import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Broker, typingTiming } from '../src/broker.ts'
import { sleep, tempDir } from './helpers.ts'

let tmp: ReturnType<typeof tempDir>
let b: Broker
const actions: number[] = []

beforeEach(() => {
  actions.length = 0
  typingTiming.everyMs = 20
  typingTiming.maxMs = 60_000
  tmp = tempDir()
  b = new Broker({ state_dir: tmp.dir, lang: 'en', api_root: '', listen: '127.0.0.1:1' } as any, [])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
  const api = {
    sendChatAction: async (_c: number, _a: string, o: any) => { actions.push(o?.message_thread_id ?? 0) },
    setMessageReaction: async () => true,
    sendMessage: async () => ({ message_id: 900 }),
  }
  ;(b.tg as any).enqueue = (_c: number, _m: boolean, fn: (a: any) => Promise<any>) => fn(api)
  ;(b.tg as any).api = () => api
  ;(b.server as any).connectedSince = () => 1
})
afterEach(() => {
  b.stop()
  tmp.rm()
})

function ackOne(): void {
  b.store.ingest('bot', { update_id: 5, topic: 'wms', message_id: 55, user: 'o', user_id: '42', ts: '', text: 'hi' })
  ;(b as any).onAck('wms', 5)
}

const conn = { id: 1, mode: 'topic', topic: 'wms' } as const

test('typing starts on ack, in the topic thread, and repeats', async () => {
  ackOne()
  await sleep(70)
  expect(b.isTyping('wms')).toBe(true)
  expect(actions.length).toBeGreaterThanOrEqual(3)
  expect(new Set(actions)).toEqual(new Set([7]))
})

test('a silent reply keeps it, a loud reply stops it', async () => {
  ackOne()
  await (b as any).handleTool('reply', { text: 'progress', silent: true }, conn)
  expect(b.isTyping('wms')).toBe(true)
  await (b as any).handleTool('reply', { text: 'done' }, conn)
  expect(b.isTyping('wms')).toBe(false)
})

test('the shim going away stops it', async () => {
  ackOne()
  ;(b.server as any).connectedSince = () => null
  await sleep(50)
  expect(b.isTyping('wms')).toBe(false)
})
