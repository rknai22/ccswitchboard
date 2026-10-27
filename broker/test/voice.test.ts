import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { Broker } from '../src/broker.ts'
import { transcribe } from '../src/voice.ts'
import { sleep, tempDir } from './helpers.ts'

let tmp: ReturnType<typeof tempDir>
let srv: ReturnType<typeof Bun.serve>
let seen: { auth: string | null; model: unknown; size: number }[]
let reply: () => Response

beforeEach(() => {
  tmp = tempDir()
  seen = []
  reply = () => Response.json({ text: ' привет, проверь логи ' })
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const f = await req.formData()
      const file = f.get('file') as Blob
      seen.push({ auth: req.headers.get('authorization'), model: f.get('model'), size: file.size })
      return reply()
    },
  })
})
afterEach(() => {
  srv.stop(true)
  tmp.rm()
})

const cfg = (key = true) => {
  const kf = join(tmp.dir, 'openai.key')
  if (key) writeFileSync(kf, 'sk-test\n')
  return { openai_key_file: kf, openai_model: 'whisper-1', openai_api: `http://127.0.0.1:${srv.port}`, lang: 'ru' } as any
}
const file = { name: 'a.oga', data_b64: Buffer.from('OggS....').toString('base64') }

test('transcribe sends the audio with the key and returns trimmed text', async () => {
  expect(await transcribe(cfg(), file, 'audio/ogg')).toEqual({ ok: true, text: 'привет, проверь логи' })
  expect(seen[0]).toEqual({ auth: 'Bearer sk-test', model: 'whisper-1', size: 8 })
})

test('no key file → no call', async () => {
  expect(await transcribe(cfg(false), file, undefined)).toEqual({ ok: false, error: 'no_key' })
  expect(seen).toHaveLength(0)
})

test('HTTP error → reason', async () => {
  reply = () => new Response('nope', { status: 401 })
  expect(await transcribe(cfg(), file, undefined)).toEqual({ ok: false, error: 'http_401' })
})

test('a voice message reaches the session as 🎤 text, attachment kept', async () => {
  const c = cfg()
  const b = new Broker({ ...c, state_dir: tmp.dir, listen: '127.0.0.1:1', api_root: '' } as any, [])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
  ;(b.tg as any).download = async () => file
  ;(b.tg as any).enqueue = async () => true
  ;(b.tg as any).botId = () => 'bot'
  const pushed: any[] = []
  ;(b.server as any).push = (ev: any) => pushed.push(ev)
  await (b as any).handleUpdate({
    update_id: 50,
    message: {
      message_id: 9, date: 0, chat: { id: -100, type: 'supergroup' }, from: { id: 42, is_bot: false, first_name: 'o' },
      is_topic_message: true, message_thread_id: 7, voice: { file_id: 'F', file_unique_id: 'U', duration: 3, mime_type: 'audio/ogg' },
    },
  })
  for (let i = 0; i < 50 && !pushed.length; i++) await sleep(20)
  expect(pushed[0].text).toBe('🎤 привет, проверь логи')
  expect(pushed[0].attachment.kind).toBe('voice')
  expect(b.store.undelivered('wms')[0]!.text).toBe('🎤 привет, проверь логи')
  b.stop()
})

test('a text after a voice message waits for the transcript: order kept', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  reply = () => Response.json({ text: 'first' })
  const c = cfg()
  const b = new Broker({ ...c, state_dir: tmp.dir, listen: '127.0.0.1:1', api_root: '' } as any, [])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
  ;(b.tg as any).download = async () => { await gate; return file }
  ;(b.tg as any).enqueue = async () => true
  ;(b.tg as any).botId = () => 'bot'
  const pushed: any[] = []
  ;(b.server as any).push = (ev: any) => pushed.push(ev)
  const msg = (id: number, extra: object) => ({
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: -100, type: 'supergroup' }, from: { id: 42, is_bot: false, first_name: 'o' }, is_topic_message: true, message_thread_id: 7, ...extra },
  })
  await (b as any).handleUpdate(msg(60, { voice: { file_id: 'F', file_unique_id: 'U', duration: 3 } }))
  await (b as any).handleUpdate(msg(61, { text: 'second' }))
  await sleep(50)
  expect(pushed).toHaveLength(0)
  release()
  for (let i = 0; i < 50 && pushed.length < 2; i++) await sleep(20)
  expect(pushed.map(e => e.text)).toEqual(['🎤 first', 'second'])
  b.stop()
})
