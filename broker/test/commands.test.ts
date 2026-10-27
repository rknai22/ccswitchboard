import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Broker } from '../src/broker.ts'
import { commandOf, statusText } from '../src/commands.ts'
import { tempDir } from './helpers.ts'

test('commandOf: plain, with @bot, and not a command', () => {
  expect(commandOf('/status')).toBe('status')
  expect(commandOf('/restart@my_bot ')).toBe('restart')
  expect(commandOf('/status please')).toBeNull()
  expect(commandOf('status')).toBeNull()
})

let tmp: ReturnType<typeof tempDir>
let b: Broker
beforeEach(() => {
  tmp = tempDir()
  b = new Broker({ state_dir: tmp.dir, lang: 'ru', api_root: '', listen: '127.0.0.1:1', timezone: 'UTC' } as any, [])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
})
afterEach(() => {
  b.stop()
  tmp.rm()
})

const msg = (text: string) => ({
  message_id: 1, date: 0, chat: { id: -100, type: 'supergroup' }, from: { id: 42, is_bot: false, first_name: 'o' },
  is_topic_message: true, message_thread_id: 7, text,
}) as any

test('a command in a topic is not queued for the session', () => {
  expect((b as any).route(10, msg('/status'))).toBeNull()
  const r = (b as any).route(11, msg('hello'))
  expect(r.ev.topic).toBe('wms')
})

test('status text: down, pending count, last reply', () => {
  const ctx = (b as any).base
  b.store.ingest('bot', { update_id: 5, topic: 'wms', message_id: 55, user: 'o', user_id: '42', ts: '', text: 'x' })
  b.store.set('topic:wms:last_reply_at', Date.UTC(2026, 9, 28, 9, 30))
  expect(statusText(ctx, 'wms')).toBe('🔴 сессия не на связи\nждут доставки: 1\nпоследний ответ: 09:30')
})
