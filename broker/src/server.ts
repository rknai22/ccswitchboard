// === GRACE START_BLOCK: broker_server =========================================
// MODULE_CONTRACT:
//   IN:  TCP connections from channel shims on config.listen, NDJSON framed
//        (plugin/protocol.ts). First line must be hello within 10 s.
//   OUT: welcome{topic|setup} or reject+close; events of the bound topic in
//        queue order; results of tool calls; unbound on reset/topic close.
//   INV: one connection per topic. A new hello with the same key takes the
//        topic only when the old connection is dead: one that knows ping is
//        asked first and keeps the topic if it answers within pingWaitMs (a
//        stray second shim — e.g. from `claude mcp list` — must not deafen a
//        live session); one that does not know ping is replaced as before (a
//        restarted session must not lose its topic to a half-dead
//        predecessor). Hellos of one topic are decided one at a time.
//   INV: an event counts as delivered only on the shim's ack; on (re)connect
//        every unacked event of the topic is sent again, in order.
//   INV: a NEW shim instance (another process — the session restarted) that
//        knows 'redelivery' also gets, marked redelivered, what the previous
//        instance acked in the last redeliverWindowMs before it went away:
//        an ack only says the shim handed it to Claude, and a Claude that
//        crashed right then never kept it. A reconnect of the same instance
//        or an old shim gets no redeliveries.
//   INV: a call for a tool missing from the connection's welcome.tools is
//        refused here, before any handler runs.

import { randomUUID } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import {
  LineDecoder, PROTOCOL_VERSION, encode, parseBrokerAddr,
  type BrokerToShim, type Capability, type GeneralTools, type SetupTools, type ToolName, type TopicTools,
} from '../../plugin/protocol.ts'
import { log, type ConnInfo } from './context.ts'
import type { Store, StoredEvent } from './store.ts'

const HELLO_TIMEOUT_MS = 10_000
const CAPS: Capability[] = ['ping', 'redelivery']

export const serverTiming = {
  /** How long a live shim has to answer ping; generous because a shim busy
   *  sending a big file answers late. */
  pingWaitMs: 10_000,
  redeliverWindowMs: 30 * 60_000,
}
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
  /** A hello was refused because the topic's shim answered ping. */
  onTakeoverRefused?(topic: string): void
  /** First ack of an event: the shim handed it to Claude. */
  onAck?(topic: string, updateId: number): void
}

class Conn {
  info: ConnInfo
  tools: ToolName[] = []
  bound = false
  /** Epoch ms of the welcome; the session watchdog reads it. */
  since = 0
  caps = new Set<Capability>()
  instance: string | undefined
  pongs = new Map<string, () => void>()
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
  private helloChains = new Map<string, Promise<void>>()
  private stopped = false

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
    // Sockets close after this returns; their handlers must not touch a store
    // the caller is about to close.
    this.stopped = true
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

  /** Welcome time of the topic's bound connection, or null when none is. */
  connectedSince(topic: string): number | null {
    const c = this.byTopic.get(topic)
    return c?.bound && !c.sock.destroyed ? c.since : null
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
      if (c.info.topic && this.byTopic.get(c.info.topic) === c) {
        this.byTopic.delete(c.info.topic)
        if (c.instance && !this.stopped) this.deps.store.set(`topic:${c.info.topic}:instance_gone_at`, Date.now())
      }
      log('server', 'conn_close', { conn: c.info.id, topic: c.info.topic ?? null })
    })
  }

  private reject(c: Conn, reason: string): void {
    log('server', 'reject', { conn: c.info.id, reason })
    c.send({ t: 'reject', reason })
    c.sock.end()
  }

  private hello(c: Conn, m: unknown): void {
    const h = m as { t?: unknown; v?: unknown; key?: unknown; instance?: unknown; caps?: unknown }
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

    c.caps = new Set(Array.isArray(h.caps) ? h.caps.filter((x): x is Capability => CAPS.includes(x)) : [])
    c.instance = typeof h.instance === 'string' && h.instance ? h.instance.slice(0, 64) : undefined
    const name = topic.name
    const prev = this.helloChains.get(name) ?? Promise.resolve()
    const run = prev.then(() => this.claim(c, name))
    this.helloChains.set(name, run.catch(() => {}))
  }

  /** Give the topic to c unless a live connection holds it. */
  private async claim(c: Conn, name: string): Promise<void> {
    if (c.sock.destroyed || this.stopped) return
    const topic = this.deps.store.topic(name)
    if (!topic || topic.state !== 'open') return this.reject(c, `topic ${name} is closed`)
    const old = this.byTopic.get(name)
    if (old && old !== c && old.bound && !old.sock.destroyed && old.caps.has('ping')) {
      const alive = await this.ping(old, serverTiming.pingWaitMs)
      if (c.sock.destroyed || this.stopped) return
      if (alive && this.byTopic.get(name) === old && old.bound) {
        log('server', 'takeover_refused', { conn: c.info.id, holder: old.info.id, topic: name })
        this.deps.onTakeoverRefused?.(name)
        return this.reject(c, `topic ${name} is held by a live session`)
      }
    }
    const cur = this.byTopic.get(name)
    if (cur && cur !== c) {
      if (cur.instance) this.deps.store.set(`topic:${name}:instance_gone_at`, Date.now())
      cur.bound = false
      cur.send({ t: 'unbound', reason: 'replaced by a newer connection for this topic' })
      cur.sock.end()
      log('server', 'replaced', { conn: cur.info.id, by: c.info.id, topic: name })
    }
    c.info = { id: c.info.id, mode: 'topic', topic: name }
    c.tools = [...TOPIC_TOOLS, ...(name === 'general' ? GENERAL_TOOLS : []), ...BOUND_SETUP_TOOLS]
    c.bound = true
    c.since = Date.now()
    this.byTopic.set(name, c)
    c.send({ t: 'welcome', mode: 'topic', topic: name, tools: c.tools })
    const backlog = this.deps.store.undelivered(name)
    for (const ev of backlog) c.send({ t: 'event', ...ev })
    const st = this.deps.store
    const prevInstance = st.get(`topic:${name}:instance`)
    let again = 0
    if (c.instance && prevInstance && prevInstance !== c.instance && c.caps.has('redelivery')) {
      const goneAt = Number(st.get(`topic:${name}:instance_gone_at`) ?? 0) || Date.now()
      for (const ev of st.redeliverable(name, prevInstance, goneAt - serverTiming.redeliverWindowMs)) {
        c.send({ t: 'event', ...ev, redelivered: true })
        again++
      }
    }
    if (c.instance) {
      st.set(`topic:${name}:instance`, c.instance)
      st.del(`topic:${name}:instance_gone_at`)
    }
    log('server', 'welcome', { conn: c.info.id, mode: 'topic', topic: name, backlog: backlog.length, redelivered: again, caps: [...c.caps].join(',') || null })
  }

  /** true when c answers a fresh ping within ms; false on timeout or close. */
  private ping(c: Conn, ms: number): Promise<boolean> {
    const nonce = randomUUID()
    return new Promise(res => {
      const done = (v: boolean) => {
        clearTimeout(timer)
        c.pongs.delete(nonce)
        c.sock.off('close', onClose)
        res(v)
      }
      const onClose = () => done(false)
      const timer = setTimeout(() => done(false), ms)
      c.pongs.set(nonce, () => done(true))
      c.sock.on('close', onClose)
      c.send({ t: 'ping', nonce })
    })
  }

  private message(c: Conn, m: unknown): void {
    const msg = m as { t?: unknown; update_id?: unknown; id?: unknown; tool?: unknown; args?: unknown; nonce?: unknown }
    if (msg?.t === 'pong') {
      if (typeof msg.nonce === 'string') c.pongs.get(msg.nonce)?.()
      return
    }
    if (msg?.t === 'ack') {
      if (c.info.mode !== 'topic' || !c.bound || typeof msg.update_id !== 'number') return
      const ok = this.deps.store.markDelivered(c.info.topic!, msg.update_id, c.instance)
      log('server', 'ack', { conn: c.info.id, topic: c.info.topic!, update_id: msg.update_id, fresh: ok })
      if (ok) this.deps.onAck?.(c.info.topic!, msg.update_id)
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
