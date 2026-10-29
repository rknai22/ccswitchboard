import { afterEach, beforeEach, expect, test } from 'bun:test'
import { GrammyError } from 'grammy'
import { Broker } from '../src/broker.ts'
import { tempDir } from './helpers.ts'

let tmp: ReturnType<typeof tempDir>
let b: Broker
let edits: { text: unknown; opts: any }[]
let refuse: (text: unknown) => boolean

const conn = { id: 1, mode: 'topic' as const, topic: 'wms' }
const err = (code: number, description: string) =>
  new GrammyError('x', { ok: false, error_code: code, description } as any, 'editMessageText', {})

beforeEach(async () => {
  tmp = tempDir()
  edits = []
  refuse = () => false
  b = new Broker({ state_dir: tmp.dir, lang: 'en', api_root: '', listen: '127.0.0.1:1' } as any, [])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
  const api = {
    sendMessage: async () => ({ message_id: 900 }),
    sendChatAction: async () => true,
    editMessageText: async (_c: number, _id: number, text: unknown, opts: any) => {
      if (refuse(text)) throw err(400, 'Bad Request: message must be edited the same way')
      edits.push({ text, opts })
      return true
    },
  }
  ;(b.tg as any).enqueue = (_c: number, _m: boolean, fn: (a: any) => Promise<any>) => fn(api)
  ;(b.tg as any).api = () => api
  await (b as any).sendTopic('wms', 'status', { silent: true })
})
afterEach(() => {
  b.stop()
  tmp.rm()
})

const edit = (text: string) => (b as any).handleTool('edit_message', { message_id: 900, text }, conn)

test('edit with a table → rich_message markdown', async () => {
  await edit('| a | b |\n|---|---|\n| $1 | 2 |')
  expect(edits).toHaveLength(1)
  expect(edits[0]!.text).toEqual({ markdown: '| a | b |\n|---|---|\n| \\$1 | 2 |' })
})

test('plain edit → HTML, as before', async () => {
  await edit('⚙️ **now**')
  expect(edits[0]!.text).toBe('⚙️ <b>now</b>')
  expect(edits[0]!.opts.parse_mode).toBe('HTML')
})

test('a rich message edited with plain text Telegram refuses → retried as rich', async () => {
  refuse = text => typeof text === 'string'
  await edit('done')
  expect(edits).toEqual([{ text: { markdown: 'done' }, opts: undefined }])
})

test('rich edit refused → HTML', async () => {
  refuse = text => typeof text !== 'string'
  await edit('## Done')
  expect(edits[0]!.text).toBe('<b>Done</b>')
})

test('both ways refused → the first error', async () => {
  refuse = () => true
  await expect(edit('## Done')).rejects.toThrow(/edited the same way/)
})
