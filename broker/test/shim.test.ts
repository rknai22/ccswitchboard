// The real shim (plugin/server.ts) as a child process: MCP over stdio from a
// test client (playing Claude Code), NDJSON over TCP to a fake broker.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '../../plugin/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../../plugin/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { LineDecoder, encode } from '../../plugin/protocol.ts'
import { sleep } from './helpers.ts'

const SHIM = new URL('../../plugin/server.ts', import.meta.url).pathname

type Broker = { srv: Server; port: number; sock: Promise<Socket>; got: any[]; next(t: string, ms?: number): Promise<any>; send(m: unknown): void }

function fakeBroker(): Promise<Broker> {
  return new Promise(res => {
    const got: any[] = []
    const waiters: { t: string; res: (m: any) => void }[] = []
    let current: Socket | null = null
    let gotSock!: (s: Socket) => void
    const sock = new Promise<Socket>(r => (gotSock = r))
    const srv = createServer(s => {
      current = s
      s.setEncoding('utf8')
      const dec = new LineDecoder()
      s.on('data', (c: string) => {
        for (const m of dec.push(c) as any[]) {
          if (m.t === 'hello') {
            s.write(encode({ t: 'welcome', mode: 'topic', topic: 'wms', tools: ['reply'] }))
          }
          const i = waiters.findIndex(w => w.t === m.t)
          if (i >= 0) waiters.splice(i, 1)[0]!.res(m)
          else got.push(m)
        }
      })
      s.on('error', () => {})
      gotSock(s)
    })
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      res({
        srv, port, sock, got,
        next(t, ms = 5000) {
          const i = got.findIndex(m => m.t === t)
          if (i >= 0) return Promise.resolve(got.splice(i, 1)[0])
          return new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`no ${t}`)), ms)
            waiters.push({ t, res: m => { clearTimeout(timer); ok(m) } })
          })
        },
        send: m => current?.write(encode(m as never)),
      })
    })
  })
}

let broker: Broker
let client: Client
let home: string
const notes: any[] = []

beforeEach(async () => {
  notes.length = 0
  broker = await fakeBroker()
  home = mkdtempSync(join(tmpdir(), 'ccsb-shim-'))
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [SHIM],
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CCSB_KEY: 'k', CCSB_BROKER: `127.0.0.1:${broker.port}` } as Record<string, string>,
    stderr: 'ignore',
  })
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { notes.push(n) }
  await client.connect(transport)
})

afterEach(async () => {
  await client.close()
  broker.srv.close()
  rmSync(home, { recursive: true, force: true })
})

const ev = (update_id: number, extra: object = {}) => ({
  t: 'event', update_id, topic: 'wms', message_id: update_id, user: 'o', user_id: '1', ts: new Date().toISOString(), text: 'hi', ...extra,
})

test('hello carries an instance id and caps', async () => {
  const h = await broker.next('hello')
  expect(h.instance).toMatch(/^[0-9a-f-]{36}$/)
  expect(h.caps).toEqual(['ping', 'redelivery'])
})

test('ping → pong with the same nonce', async () => {
  await broker.next('hello')
  broker.send({ t: 'ping', nonce: 'n-1' })
  expect((await broker.next('pong')).nonce).toBe('n-1')
})

test('redelivered event → meta.redelivered and an ack', async () => {
  await broker.next('hello')
  broker.send(ev(5, { redelivered: true }))
  expect((await broker.next('ack')).update_id).toBe(5)
  await sleep(50)
  const n = notes.find(x => x.method === 'notifications/claude/channel')
  expect(n.params.meta.redelivered).toBe('true')
})

test('same update_id twice → one notification, two acks', async () => {
  await broker.next('hello')
  broker.send(ev(9))
  await broker.next('ack')
  broker.send(ev(9))
  await broker.next('ack')
  await sleep(50)
  expect(notes.filter(x => x.method === 'notifications/claude/channel').length).toBe(1)
})

test('quote text and forward origin reach the meta, cleaned', async () => {
  await broker.next('hello')
  broker.send(ev(11, { reply_to: { message_id: 3, text: 'line1\n<tag>' }, forwarded_from: { from: 'Ann (@ann)', date: '2026-10-28T00:00:00.000Z' } }))
  await broker.next('ack')
  await sleep(50)
  const meta = notes.find(x => x.method === 'notifications/claude/channel').params.meta
  expect(meta.reply_to_text).toBe('line1 ⏎ _tag_')
  expect(meta.forwarded_from).toBe('Ann (@ann)')
  expect(meta.forwarded_date).toBe('2026-10-28T00:00:00.000Z')
})

test('task_id, from_topic and answer_to reach the meta', async () => {
  await broker.next('hello')
  broker.send(ev(12, { task_id: 7, from_topic: 'crm', answer_to: { question_id: 3, question: 'Push?' } }))
  await broker.next('ack')
  await sleep(50)
  const meta = notes.find(x => x.method === 'notifications/claude/channel').params.meta
  expect(meta.task_id).toBe('7')
  expect(meta.from_topic).toBe('crm')
  expect(meta.answer_to_question_id).toBe('3')
  expect(meta.answer_to_question).toBe('Push?')
})
