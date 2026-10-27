import { expect, test } from 'bun:test'
import { forwardOrigin } from '../src/broker.ts'

const date = 1_700_000_000

test('user', () => {
  expect(forwardOrigin({ forward_origin: { type: 'user', date, sender_user: { id: 1, is_bot: false, first_name: 'Ann', last_name: 'Lee', username: 'ann' } } } as any))
    .toEqual({ from: 'Ann Lee (@ann)', date: new Date(date * 1000).toISOString() })
})
test('hidden user', () => {
  expect(forwardOrigin({ forward_origin: { type: 'hidden_user', date, sender_user_name: 'Bob' } } as any)!.from).toBe('Bob')
})
test('chat', () => {
  expect(forwardOrigin({ forward_origin: { type: 'chat', date, sender_chat: { id: 2, type: 'group', title: 'Team' } } } as any)!.from).toBe('Team')
})
test('channel with signature, delimiters cleaned', () => {
  expect(forwardOrigin({ forward_origin: { type: 'channel', date, chat: { id: 3, type: 'channel', title: 'News <x>' }, message_id: 9, author_signature: 'Ed' } } as any)!.from)
    .toBe('News _x_ — Ed')
})
test('not forwarded', () => {
  expect(forwardOrigin({} as any)).toBeUndefined()
})
