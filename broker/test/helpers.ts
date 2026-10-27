// Test helpers: a throwaway store, a broker server on a free port, and a fake
// shim speaking the NDJSON protocol over a real TCP socket.

import { mkdtempSync, rmSync } from 'fs'
import { createConnection, createServer, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { LineDecoder, encode, PROTOCOL_VERSION, type Capability } from '../../plugin/protocol.ts'
import { BrokerServer, type ServerDeps } from '../src/server.ts'
import { Store } from '../src/store.ts'

export function tempDir(): { dir: string; rm(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccsb-test-'))
  return { dir, rm: () => rmSync(dir, { recursive: true, force: true }) }
}

export type TestServer = { server: BrokerServer; addr: string; store: Store; dir: string; close(): void }

export async function startServer(opts: { dir?: string; deps?: Partial<ServerDeps> } = {}): Promise<TestServer> {
  const tmp = opts.dir ? null : tempDir()
  const dir = opts.dir ?? tmp!.dir
  const store = new Store(dir)
  const server = new BrokerServer({
    store,
    isLocked: () => true,
    handle: async () => ({}),
    ...opts.deps,
  })
  const addr = `127.0.0.1:${await freePort()}`
  await server.listen(addr)
  return {
    server, addr, store, dir,
    close() {
      server.close()
      store.close()
      tmp?.rm()
    },
  }
}

function freePort(): Promise<number> {
  return new Promise(res => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port
      srv.close(() => res(p))
    })
  })
}

export function ensureTopic(store: Store, name = 'wms'): string {
  return (store.topic(name) ?? store.createTopic({ name, chat_id: -100, thread_id: 7 })).key
}

export type FakeShim = {
  msgs: any[]
  answerPings: boolean
  send(m: unknown): void
  next(t: string, ms?: number): Promise<any>
  close(): void
  closed: Promise<void>
}

export function fakeShim(
  addr: string,
  hello: { key?: string; instance?: string; caps?: Capability[] },
  opts: { answerPings?: boolean } = {},
): Promise<FakeShim> {
  const [host, port] = [addr.slice(0, addr.lastIndexOf(':')), Number(addr.slice(addr.lastIndexOf(':') + 1))]
  const sock: Socket = createConnection({ host, port })
  sock.setEncoding('utf8')
  const dec = new LineDecoder()
  const waiters: { t: string; from: number; res: (m: any) => void }[] = []
  let resolveClosed!: () => void
  const shim: FakeShim = {
    msgs: [],
    answerPings: opts.answerPings ?? true,
    send: m => sock.write(encode(m as never)),
    next(t, ms = 3000) {
      const from = shim.msgs.length
      const seen = shim.msgs.find(m => m.t === t && !m.__taken)
      if (seen) {
        seen.__taken = true
        return Promise.resolve(seen)
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`no ${t} within ${ms} ms`)), ms)
        waiters.push({ t, from, res: m => { clearTimeout(timer); res(m) } })
      })
    },
    close: () => sock.destroy(),
    closed: new Promise(r => (resolveClosed = r)),
  }
  sock.on('data', (chunk: string) => {
    for (const m of dec.push(chunk) as any[]) {
      shim.msgs.push(m)
      if (m.t === 'ping' && shim.answerPings) shim.send({ t: 'pong', nonce: m.nonce })
      const i = waiters.findIndex(w => w.t === m.t)
      if (i >= 0) {
        m.__taken = true
        waiters.splice(i, 1)[0]!.res(m)
      }
    }
  })
  sock.on('close', () => resolveClosed())
  sock.on('error', () => {})
  return new Promise(res => {
    sock.on('connect', () => {
      shim.send({ t: 'hello', v: PROTOCOL_VERSION, ...hello })
      res(shim)
    })
  })
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
