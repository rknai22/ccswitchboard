// === GRACE START_BLOCK: broker_server =========================================
// MODULE_CONTRACT:
//   IN:  TCP connections from channel shims on config.listen, NDJSON framed
//        (plugin/protocol.ts). First line must be hello within 10 s.
//   OUT: welcome{topic|setup} or reject+close; events of the bound topic in
//        queue order; results of tool calls; unbound on reset/topic close.
//   INV: one connection per topic — a new hello with the same key replaces the
//        old connection (it gets unbound): a restarted session must not lose
//        its topic to a half-dead predecessor.
//   INV: an event counts as delivered only on the shim's ack; on (re)connect
//        every unacked event of the topic is sent again, in order.
//   INV: a call for a tool missing from the connection's welcome.tools is
//        refused here, before any handler runs.

import { createServer, type Server, type Socket } from 'net'
import {
  LineDecoder, PROTOCOL_VERSION, encode, parseBrokerAddr,
  type BrokerToShim, type GeneralTools, type SetupTools, type ToolName, type TopicTools,
} from '../../plugin/protocol.ts'
import { log, type ConnInfo } from './context.ts'
import type { Store, StoredEvent } from './store.ts'

const HELLO_TIMEOUT_MS = 10_000
// Biggest legit line: a reply with several 50 MB files in base64.
const MAX_LINE_CHARS = 400 * 1024 * 1024

export const TOPIC_TOOLS: TopicTools[] = ['reply', 'react', 'edit_message', 'download_attachment']
export const GENERAL_TOOLS: GeneralTools[] = ['create_topic', 'forward']
export const SETUP_TOOLS: SetupTools[] = ['setup_token', 'setup_status', 'reset']
/** Bound sessions may ask for a reset (only the owner's button press applies
 *  it) and read the state; setup_token stays keyless-only. */
export const BOUND_SETUP_TOOLS: SetupTools[] = ['setup_status', 'reset']

export type ServerDeps = {
  store: Store
  isLocked(): boolean
  handle(tool: ToolName, args: unknown, conn: ConnInfo): Promise<unknown>
}

class Conn {
  info: ConnInfo
  tools: ToolName[] = []
  bound = false
  constructor(readonly sock: Socket, id: number) {
    this.info = { id, mode: 'setup' }
  }
  send(msg: BrokerToShim): void {
    if (!this.sock.destroyed) this.sock.write(encode(msg))
  }
}

export class BrokerServer {
  private server: Server | null = null
  private nextId = 1
  private byTopic = new Map<string, Conn>()
  private conns = new Set<Conn>()

  constructor(private deps: ServerDeps) {}

  listen(addr: string): Promise<void> {
    const { host, port } = parseBrokerAddr(addr)
    this.server = createServer(sock => this.accept(sock))
    return new Promise((res, rej) => {
      this.server!.once('error', rej)
      this.server!.listen(port, host, () => {
        log('server', 'listen', { host, port })
        res()
      })
    })
  }

  close(): void {
    for (const c of this.conns) c.sock.destroy()
    this.server?.close()
  }

  /** Push a freshly queued event to its topic's shim, if one is bound. */
  push(ev: StoredEvent): void {
    const c = this.byTopic.get(ev.topic)
    if (c?.bound) c.send({ t: 'event', ...ev })
  }

  unbind(topic: string, reason: string): void {
    const c = this.byTopic.get(topic)
    if (!c) return
    this.byTopic.delete(topic)
    c.bound = false
    c.send({ t: 'unbound', reason })
    log('server', 'unbound', { conn: c.info.id, topic, reason })
  }

  /** Reset: every connection — topic and setup alike — loses its binding. */
  unbindAll(reason: string): void {
    for (const topic of [...this.byTopic.keys()]) this.unbind(topic, reason)
  }

  connectedTopics(): string[] {
    return [...this.byTopic.keys()]
  }

  private accept(sock: Socket): void {
    const c = new Conn(sock, this.nextId++)
    this.conns.add(c)
    sock.setEncoding('utf8')
    sock.setNoDelay(true)
    sock.setKeepAlive(true, 30_000)
    let greeted = false
    const helloTimer = setTimeout(() => {
      if (!greeted) this.reject(c, 'no hello')
    }, HELLO_TIMEOUT_MS)
    const dec = new LineDecoder(line => {
      log('server', 'bad_line', { conn: c.info.id, len: line.length })
    })
    log('server', 'conn_open', { conn: c.info.id, remote: sock.remoteAddress ?? null })

    sock.on('data', (chunk: string) => {
      let msgs: unknown[]
      try {
        msgs = dec.push(chunk)
      } catch (e) {
        log('server', 'decode_failed', { conn: c.info.id, err: String(e) })
        sock.destroy()
        return
      }
      if (dec.pending > MAX_LINE_CHARS) {
        log('server', 'line_too_long', { conn: c.info.id, len: dec.pending })
        sock.destroy()
        return
      }
      for (const m of msgs) {
        if (!greeted) {
          greeted = true
          clearTimeout(helloTimer)
          this.hello(c, m)
        } else {
          this.message(c, m)
        }
      }
    })
    sock.on('error', e => log('server', 'conn_error', { conn: c.info.id, err: e.message }))
    sock.on('close', () => {
      clearTimeout(helloTimer)
      this.conns.delete(c)
      if (c.info.topic && this.byTopic.get(c.info.topic) === c) this.byTopic.delete(c.info.topic)
      log('server', 'conn_close', { conn: c.info.id, topic: c.info.topic ?? null })
    })
  }

  private reject(c: Conn, reason: string): void {
    log('server', 'reject', { conn: c.info.id, reason })
    c.send({ t: 'reject', reason })
    c.sock.end()
  }

  private hello(c: Conn, m: unknown): void {
    const h = m as { t?: unknown; v?: unknown; key?: unknown }
    if (h?.t !== 'hello') return this.reject(c, 'expected hello')
    if (h.v !== PROTOCOL_VERSION) return this.reject(c, `unsupported protocol version ${String(h.v)} (broker speaks ${PROTOCOL_VERSION})`)

    if (h.key === undefined || h.key === null || h.key === '') {
      c.info = { id: c.info.id, mode: 'setup' }
      c.tools = [...SETUP_TOOLS]
      c.bound = true
      c.send({ t: 'welcome', mode: 'setup', tools: c.tools })
      log('server', 'welcome', { conn: c.info.id, mode: 'setup' })
      return
    }
    if (typeof h.key !== 'string') return this.reject(c, 'bad key')
    if (!this.deps.isLocked()) return this.reject(c, 'broker is not configured — run /ccswitchboard:setup')
    const topic = this.deps.store.topicByKey(h.key)
    if (!topic) return this.reject(c, 'unknown topic key')
    if (topic.state !== 'open') return this.reject(c, `topic ${topic.name} is closed`)

    const old = this.byTopic.get(topic.name)
    if (old && old !== c) {
      old.bound = false
      old.send({ t: 'unbound', reason: 'replaced by a newer connection for this topic' })
      old.sock.end()
      log('server', 'replaced', { conn: old.info.id, by: c.info.id, topic: topic.name })
    }
    c.info = { id: c.info.id, mode: 'topic', topic: topic.name }
    c.tools = [...TOPIC_TOOLS, ...(topic.name === 'general' ? GENERAL_TOOLS : []), ...BOUND_SETUP_TOOLS]
    c.bound = true
    this.byTopic.set(topic.name, c)
    c.send({ t: 'welcome', mode: 'topic', topic: topic.name, tools: c.tools })
    const backlog = this.deps.store.undelivered(topic.name)
    for (const ev of backlog) c.send({ t: 'event', ...ev })
    log('server', 'welcome', { conn: c.info.id, mode: 'topic', topic: topic.name, backlog: backlog.length })
  }

  private message(c: Conn, m: unknown): void {
    const msg = m as { t?: unknown; update_id?: unknown; id?: unknown; tool?: unknown; args?: unknown }
    if (msg?.t === 'ack') {
      if (c.info.mode !== 'topic' || !c.bound || typeof msg.update_id !== 'number') return
      const ok = this.deps.store.markDelivered(c.info.topic!, msg.update_id)
      log('server', 'ack', { conn: c.info.id, topic: c.info.topic!, update_id: msg.update_id, fresh: ok })
      return
    }
    if (msg?.t === 'call') {
      const id = typeof msg.id === 'string' ? msg.id : String(msg.id ?? '')
      const tool = msg.tool as ToolName
      if (!c.bound) {
        c.send({ t: 'result', id, ok: false, error: 'this session is no longer bound to a topic' })
        return
      }
      if (!c.tools.includes(tool)) {
        c.send({ t: 'result', id, ok: false, error: `tool ${String(msg.tool)} is not available on this connection` })
        return
      }
      const started = Date.now()
      this.deps.handle(tool, msg.args ?? {}, c.info).then(
        data => {
          c.send({ t: 'result', id, ok: true, data: data as never })
          log('server', 'call', { conn: c.info.id, topic: c.info.topic ?? null, tool, ok: true, ms: Date.now() - started })
        },
        (e: unknown) => {
          const error = e instanceof Error ? e.message : String(e)
          c.send({ t: 'result', id, ok: false, error })
          log('server', 'call', { conn: c.info.id, topic: c.info.topic ?? null, tool, ok: false, ms: Date.now() - started })
        },
      )
      return
    }
    log('server', 'unknown_message', { conn: c.info.id, t: String(msg?.t) })
  }
}
// === GRACE END_BLOCK: broker_server ===========================================
