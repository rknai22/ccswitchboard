import { expect, test } from 'bun:test'
import { GrammyError } from 'grammy'
import { Telegram } from '../src/telegram.ts'

type Sent = { method: string; text?: string; opts: any }

function fakeTg(failHtmlOnce = false, richError?: { code: number; description: string }) {
  const sent: Sent[] = []
  let failed = false
  const api = {
    sendRichMessage: async (_chat: number, rich: any, opts: any) => {
      if (richError) throw new GrammyError('x', { ok: false, error_code: richError.code, description: richError.description } as any, 'sendRichMessage', {})
      sent.push({ method: 'sendRichMessage', text: rich.markdown, opts })
      return { message_id: sent.length }
    },
    sendMessage: async (_chat: number, text: string, opts: any) => {
      if (failHtmlOnce && !failed && opts?.parse_mode === 'HTML') {
        failed = true
        throw new GrammyError('x', { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } as any, 'sendMessage', {})
      }
      sent.push({ method: 'sendMessage', text, opts })
      return { message_id: sent.length }
    },
    sendDocument: async (_chat: number, file: any, opts: any) => {
      sent.push({ method: 'sendDocument', text: file?.filename, opts })
      return { message_id: sent.length }
    },
    sendPhoto: async () => ({ message_id: 0 }),
  }
  const tg = new Telegram({ api_root: '' } as any, {} as any, {} as any)
  ;(tg as any).enqueue = (_c: number, _m: boolean, fn: (a: any) => Promise<any>) => fn(api)
  return { tg, sent }
}

test('markdown goes as HTML', async () => {
  const { tg, sent } = fakeTg()
  await tg.sendInto(1, 2, '**hi** <x>', { format: 'markdown' })
  expect(sent[0]!.text).toBe('<b>hi</b> &lt;x&gt;')
  expect(sent[0]!.opts.parse_mode).toBe('HTML')
})

test('markup Telegram rejects → the same piece as plain text', async () => {
  const { tg, sent } = fakeTg(true)
  await tg.sendInto(1, 2, '**hi**', { format: 'markdown' })
  expect(sent).toHaveLength(1)
  expect(sent[0]!.text).toBe('**hi**')
  expect(sent[0]!.opts.parse_mode).toBeUndefined()
})

test('over 8000 chars → the start as a message, everything as reply.md', async () => {
  const { tg, sent } = fakeTg()
  const long = ('para '.repeat(200) + '\n\n').repeat(10)
  await tg.sendInto(1, 2, long, { format: 'markdown' })
  expect(sent.filter(s => s.method === 'sendMessage')).toHaveLength(1)
  expect(sent.find(s => s.method === 'sendDocument')!.text).toBe('reply.md')
})

test('silent → disable_notification', async () => {
  const { tg, sent } = fakeTg()
  await tg.sendInto(1, 2, 'x', { format: 'markdown', silent: true })
  expect(sent[0]!.opts.disable_notification).toBe(true)
})

test('plain text stays plain and unescaped', async () => {
  const { tg, sent } = fakeTg()
  await tg.sendInto(1, 2, '**a** <b>', {})
  expect(sent[0]!.text).toBe('**a** <b>')
  expect(sent[0]!.opts.parse_mode).toBeUndefined()
})

const TABLE = '## Totals\n\n| item | $ |\n|---|--:|\n| a_b | 5 |'

test('a table or a heading → one rich message, escaped, with thread, reply and buttons', async () => {
  const { tg, sent } = fakeTg()
  const ids = await tg.sendInto(1, 2, TABLE, { format: 'markdown', reply_to: 7, silent: true, reply_markup: { inline_keyboard: [] } })
  expect(ids).toEqual([1])
  expect(sent).toHaveLength(1)
  expect(sent[0]!.method).toBe('sendRichMessage')
  expect(sent[0]!.text).toBe('## Totals\n\n| item | \\$ |\n|---|--:|\n| a\\_b | 5 |')
  expect(sent[0]!.opts).toMatchObject({ message_thread_id: 2, disable_notification: true, reply_parameters: { message_id: 7 }, reply_markup: { inline_keyboard: [] } })
})

test('rich refused (400/404) → the HTML way, as before', async () => {
  for (const code of [400, 404]) {
    const { tg, sent } = fakeTg(false, { code, description: 'Bad Request: whatever' })
    await tg.sendInto(1, 2, TABLE, { format: 'markdown' })
    expect(sent.map(s => s.method)).toEqual(['sendMessage'])
    expect(sent[0]!.opts.parse_mode).toBe('HTML')
  }
})

test('rich failing otherwise (429) → the error, no second copy', async () => {
  const { tg, sent } = fakeTg(false, { code: 429, description: 'Too Many Requests' })
  await expect(tg.sendInto(1, 2, TABLE, { format: 'markdown' })).rejects.toThrow(/0 of 1/)
  expect(sent).toHaveLength(0)
})

test('plain markdown without tables or headings stays on the HTML way', async () => {
  const { tg, sent } = fakeTg()
  await tg.sendInto(1, 2, '**hi** a | b', { format: 'markdown' })
  expect(sent.map(s => s.method)).toEqual(['sendMessage'])
})

test('rich message plus files: files follow, ids in order', async () => {
  const { tg, sent } = fakeTg()
  const ids = await tg.sendInto(1, 2, TABLE, { format: 'markdown', files: [{ name: 'a.txt', data_b64: Buffer.from('x').toString('base64') }] })
  expect(sent.map(s => s.method)).toEqual(['sendRichMessage', 'sendDocument'])
  expect(ids).toEqual([1, 2])
})
