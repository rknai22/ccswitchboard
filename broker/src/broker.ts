// === GRACE START_BLOCK: broker_core ===========================================
// MODULE_CONTRACT:
//   IN:  Config; updates from the poller; tool calls from shim connections.
//   OUT: the running broker: routes owner messages to topic queues, serves
//        topic tools addressed by the connection's binding, runs setup, and
//        hands everything else to modules through BrokerContext.
//   INV: allowlist — only owner_id, only chat_id (+ the owner's private chat,
//        which maps to "general"); anyone else is dropped without a reply.
//   INV: a topic session can edit, react to or quote only messages recorded
//        for its own topic; the shim never names a chat or a thread.
//   INV: a closed topic accepts nothing: its messages are dropped (no 👀, no
//        queue, so a reopen replays nothing), with one hint per 15 min there.
//   INV: General vs topic is decided by is_topic_message, not by the presence
//        of message_thread_id — Telegram also sets the latter on plain replies
//        in General.
//   INV: 👀 on an owner message means its topic's shim acked it (handed it to
//        Claude), not that the broker received it: no 👀 = not delivered.
//   INV: after an ack "typing…" is kept up in that chat until the session
//        sends a non-silent reply, loses its shim, or typingMaxMs passes —
//        silent replies are progress and keep it.

import { createHmac, timingSafeEqual } from 'crypto'
import type { Update, Message } from 'grammy/types'
import { MAX_TEXT_CHUNK, type Attachment, type Format, type ToolName } from '../../plugin/protocol.ts'
import { ensureStateDir, readSecret, writeSecret, deleteSecret, type Config, type Secret } from './config.ts'
import { log, type BrokerContext, type BrokerModule, type ConnInfo, type SendOpts } from './context.ts'
import { modules as defaultModules } from './modules.ts'
import { BrokerServer } from './server.ts'
import { Setup } from './setup.ts'
import { Store, type StoredEvent } from './store.ts'
import { t } from './strings.ts'
import { Telegram, describeError, isParseError, type AllowedUpdate } from './telegram.ts'
import { mdToHtml } from './markdown.ts'
import { commandOf } from './commands.ts'

const ACK_REACTION = '👀'
const CONFLICT_NOTICE_EVERY_MS = 3600_000
const CLOSED_HINT_EVERY_MS = 15 * 60_000

export const typingTiming = { everyMs: 4500, maxMs: 30 * 60_000 }

// Filenames and titles are uploader-controlled and end up inside the session's
// <channel> tag — delimiter chars would let them break out (as upstream).
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

/** Where to put 👀 for an acked event: the owner's message in the group or in
 *  the private chat (negated id, see store). Local events (forwards, wake-ups:
 *  negative update_id) were not written by the owner — no reaction. */
export function reactionTarget(
  updateId: number,
  messageId: number,
  owner: { owner_id?: number; chat_id?: number },
): { chat: number; id: number } | null {
  if (updateId < 0 || !owner.owner_id || !owner.chat_id) return null
  return messageId < 0 ? { chat: owner.owner_id, id: -messageId } : { chat: owner.chat_id, id: messageId }
}

export class Broker {
  readonly store: Store
  readonly tg: Telegram
  readonly server: BrokerServer
  readonly setup: Setup
  private sec: Secret | null
  private timers: ReturnType<typeof setInterval>[] = []
  /** topic → its "typing…" loop while the session works */
  private typingLoops = new Map<string, { timer: ReturnType<typeof setInterval>; until: number }>()
  private base: BrokerContext

  constructor(readonly cfg: Config, private mods: BrokerModule[] = defaultModules) {
    ensureStateDir(cfg)
    this.store = new Store(cfg.state_dir)
    this.sec = readSecret(cfg)
    this.tg = new Telegram(cfg, this.store, {
      onUpdate: u => this.handleUpdate(u),
      onConflict: d => this.onConflict(d),
      allowedUpdates: (): AllowedUpdate[] =>
        this.isLocked() ? ['message', 'callback_query', 'my_chat_member'] : ['my_chat_member', 'callback_query'],
    })
    this.server = new BrokerServer({
      store: this.store,
      isLocked: () => this.isLocked(),
      handle: (tool, args, conn) => this.handleTool(tool, args, conn),
      onTakeoverRefused: topic => this.onTakeoverRefused(topic),
      onAck: (topic, updateId) => this.onAck(topic, updateId),
    })
    this.setup = new Setup({
      cfg,
      store: this.store,
      tg: this.tg,
      secret: () => this.sec,
      saveSecret: s => this.saveSecret(s),
      sendGeneral: async (text, markup) => (await this.sendTopic('general', text, { reply_markup: markup }))[0]!,
      onLocked: () => this.runLocked(),
      onReset: () => this.server.unbindAll('setup was reset'),
    })
    this.base = {
      config: cfg,
      store: this.store,
      tg: {
        send: (topic, text, opts) => this.sendTopic(topic, text, opts),
        call: (fn, opts) => {
          const chat = this.sec?.chat_id
          if (!this.isLocked() || chat === undefined) return Promise.reject(new Error('broker is not configured'))
          return this.tg.enqueue(chat, opts?.message ?? false, fn)
        },
        api: () => this.tg.api(),
      },
      enqueueEvent: (topic, ev) => {
        const full = this.store.enqueueLocal({ ...ev, topic })
        this.server.push(full)
        return full
      },
      notifyGeneral: text => this.notifyGeneral(text),
      log: (ev, f) => log('module', ev, f),
      isLocked: () => this.isLocked(),
      owner: () => (this.isLocked() ? { owner_id: this.sec!.owner_id!, chat_id: this.sec!.chat_id! } : null),
      isBusy: topic => this.isTyping(topic),
      verifyWebApp: initData => (this.sec ? verifyInitData(initData, this.sec.bot_token) : null),
      pending: topic => this.store.undelivered(topic).length,
      unbind: (topic, reason) => this.server.unbind(topic, reason),
      isConnected: topic => this.server.connectedSince(topic) !== null,
      connectedSince: topic => this.server.connectedSince(topic),
    }
  }

  private ctxFor(m: BrokerModule): BrokerContext {
    return { ...this.base, log: (ev, f) => log(m.name, ev, f) }
  }

  isLocked(): boolean {
    return !!this.sec?.locked && this.sec.owner_id !== undefined && this.sec.chat_id !== undefined
  }

  async start(): Promise<void> {
    await this.server.listen(this.cfg.listen)
    for (const m of this.mods) {
      try {
        await m.start?.(this.ctxFor(m))
      } catch (e) {
        log('core', 'module_start_failed', { module: m.name, err: describeError(e) })
      }
    }
    this.setup.start()
    if (this.sec) {
      this.tg.setToken(this.sec.bot_token)
      this.tg.startPolling()
    }
    log('core', 'started', { state: this.setup.state(), modules: this.mods.length })
    this.timers.push(setInterval(() => this.store.prune(), 3600_000))
    // The CLI `reset` runs in another process: notice its work within seconds.
    this.timers.push(setInterval(() => this.reconcile(), 5_000))
  }

  stop(): void {
    for (const topic of [...this.typingLoops.keys()]) this.stopTyping(topic)
    for (const tm of this.timers) clearInterval(tm)
    this.setup.stop()
    this.tg.stopPolling()
    this.server.close()
    this.store.close()
  }

  private saveSecret(s: Secret | null): void {
    if (s) writeSecret(this.cfg, s)
    else deleteSecret(this.cfg)
    this.sec = s
    this.tg.setToken(s?.bot_token ?? null)
    if (s) this.tg.startPolling()
  }

  private reconcile(): void {
    let disk: Secret | null
    try {
      disk = readSecret(this.cfg)
    } catch (e) {
      log('core', 'secret_unreadable', { err: describeError(e) })
      return
    }
    if (!disk && this.sec) {
      log('core', 'external_reset')
      this.sec = null
      this.tg.setToken(null)
      this.server.unbindAll('setup was reset')
    } else if (disk && (!this.sec || disk.bot_token !== this.sec.bot_token || disk.locked !== this.sec.locked)) {
      log('core', 'secret_changed', { locked: disk.locked })
      this.sec = disk
      this.tg.setToken(disk.bot_token)
      this.tg.startPolling()
    }
  }

  private async runLocked(): Promise<void> {
    for (const m of this.mods) {
      try {
        await m.onLocked?.(this.ctxFor(m))
      } catch (e) {
        log('core', 'module_onlocked_failed', { module: m.name, err: describeError(e) })
      }
    }
  }

  // ---- inbound -----------------------------------------------------------------

  private async handleUpdate(u: Update): Promise<void> {
    const botId = this.tg.botId()!
    if (await this.setup.onUpdate(u)) {
      this.store.setOffset(botId, u.update_id + 1)
      return
    }
    if (u.message && this.isLocked()) {
      const r = this.route(u.update_id, u.message)
      if (r === 'drop') {
        this.store.setOffset(botId, u.update_id + 1)
        return
      }
      if (r) {
        const fresh = this.store.ingest(botId, r.ev)
        log('core', 'event', { update_id: u.update_id, topic: r.ev.topic, message_id: r.ev.message_id, len: r.ev.text.length, fresh })
        if (fresh) {
          this.server.push(r.ev)
          this.typing(u.message, r.threadId)
        }
        return
      }
    }
    for (const m of this.mods) {
      if (!m.onUpdate) continue
      try {
        if (await m.onUpdate(u, this.ctxFor(m))) break
      } catch (e) {
        log('core', 'module_update_failed', { module: m.name, update_id: u.update_id, err: describeError(e) })
      }
    }
    this.store.setOffset(botId, u.update_id + 1)
  }

  /**
   * Owner content message → event for its topic; 'drop' for anything that must
   * not reach a session; null for non-content messages (topic service events
   * and the like), which go to modules.
   */
  private route(updateId: number, m: Message): { ev: StoredEvent; threadId: number | null } | 'drop' | null {
    const s = this.sec!
    const from = m.from
    if (!from || from.id !== s.owner_id) {
      // An owner posting as "Remain anonymous" admin arrives from
      // GroupAnonymousBot with sender_chat = the group: flag it so the log
      // explains the silence (the README tells owners to turn that off).
      const anonymous = m.sender_chat?.id === s.chat_id
      log('core', 'drop_sender', { update_id: updateId, chat_id: m.chat.id, ...(anonymous ? { anonymous_admin: true } : {}) })
      return 'drop'
    }
    const dm = m.chat.type === 'private' && m.chat.id === s.owner_id
    if (!dm && m.chat.id !== s.chat_id) {
      log('core', 'drop_chat', { update_id: updateId, chat_id: m.chat.id })
      return 'drop'
    }
    // Bot commands (/status, /restart, /help) are the commands module's.
    if (typeof m.text === 'string' && commandOf(m.text)) return null
    const content = contentOf(m)
    if (!content) return null
    let topic = 'general'
    let threadId: number | null = null
    if (!dm && m.is_topic_message && m.message_thread_id !== undefined) {
      const row = this.store.topicByThread(m.message_thread_id)
      if (!row) {
        log('core', 'drop_unknown_thread', { update_id: updateId, thread_id: m.message_thread_id })
        return 'drop'
      }
      // A closed topic takes nothing: no 👀 (nobody reads it), no queue (a
      // reopen days later must not replay stale orders) — one short hint.
      if (row.state !== 'open') {
        log('core', 'drop_closed_topic', { update_id: updateId, topic: row.name })
        this.closedHint(row.name)
        return 'drop'
      }
      topic = row.name
      threadId = m.message_thread_id
    }
    const id = (n: number) => (dm ? -n : n)
    const ev: StoredEvent = {
      update_id: updateId,
      topic,
      message_id: id(m.message_id),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date(m.date * 1000).toISOString(),
      text: content.text,
      ...(content.attachment ? { attachment: content.attachment } : {}),
    }
    const fo = forwardOrigin(m)
    if (fo) ev.forwarded_from = fo
    const rt = m.reply_to_message
    // Inside a topic every message "replies" to the topic's creation message;
    // that is structure, not a quote.
    if (rt && !rt.forum_topic_created && !(m.is_topic_message && rt.message_id === m.message_thread_id)) {
      const quoted = rt.text ?? rt.caption
      ev.reply_to = { message_id: id(rt.message_id), ...(quoted ? { text: quoted } : {}) }
    }
    return { ev, threadId }
  }

  /** 👀 once the topic's shim acked the owner's message — fire and forget. */
  private onAck(topic: string, updateId: number): void {
    const ev = this.store.event(topic, updateId)
    const to = ev && this.isLocked() ? reactionTarget(updateId, ev.message_id, this.sec!) : null
    if (!to) return
    void this.tg.enqueue(to.chat, false, api =>
      api.setMessageReaction(to.chat, to.id, [{ type: 'emoji', emoji: ACK_REACTION }]),
    ).catch(e => log('core', 'ack_reaction_failed', { err: describeError(e) }))
    const thread = to.id === ev!.message_id ? (this.store.topic(topic)?.thread_id ?? null) : null
    this.startTyping(topic, to.chat, thread)
  }

  /** Keep "typing…" up in the topic while its session works on a message. */
  startTyping(topic: string, chat: number, thread: number | null): void {
    this.stopTyping(topic)
    const send = () => {
      const loop = this.typingLoops.get(topic)
      if (!loop || Date.now() > loop.until || this.server.connectedSince(topic) === null) return this.stopTyping(topic)
      void this.tg.enqueue(chat, false, api =>
        api.sendChatAction(chat, 'typing', thread !== null ? { message_thread_id: thread } : {}),
      ).catch(() => {})
    }
    const timer = setInterval(send, typingTiming.everyMs)
    timer.unref?.()
    this.typingLoops.set(topic, { timer, until: Date.now() + typingTiming.maxMs })
    send()
  }

  stopTyping(topic: string): void {
    const loop = this.typingLoops.get(topic)
    if (!loop) return
    clearInterval(loop.timer)
    this.typingLoops.delete(topic)
  }

  isTyping(topic: string): boolean {
    return this.typingLoops.has(topic)
  }

  /** "typing…" as soon as the owner's message arrives — fire and forget. */
  private typing(m: Message, threadId: number | null): void {
    const chat = m.chat.id
    void this.tg.enqueue(chat, false, api =>
      api.sendChatAction(chat, 'typing', threadId !== null ? { message_thread_id: threadId } : {}),
    ).catch(() => {})
  }

  private onTakeoverRefused(topic: string): void {
    const key = `topic:${topic}:takeover_notice_at`
    if (Date.now() - Number(this.store.get(key) ?? 0) < CLOSED_HINT_EVERY_MS) return
    this.store.set(key, Date.now())
    void this.notifyGeneral(t(this.cfg.lang, 'takeover_refused', { name: topic }))
  }

  private onConflict(description: string): void {
    const api = this.tg.api()
    // A webhook also blocks getUpdates with 409; ours is a polling bot, so a
    // webhook can only be stale or planted — remove it.
    if (/webhook/i.test(description) && api) {
      void api.deleteWebhook().then(
        () => log('tg', 'webhook_deleted'),
        e => log('tg', 'webhook_delete_failed', { err: describeError(e) }),
      )
    }
    if (!this.isLocked()) return
    const last = Number(this.store.get('conflict_notice_at') ?? 0)
    if (Date.now() - last < CONFLICT_NOTICE_EVERY_MS) return
    this.store.set('conflict_notice_at', Date.now())
    void this.notifyGeneral(t(this.cfg.lang, 'conflict_409'))
  }

  // ---- outbound ----------------------------------------------------------------

  /** "This topic is closed" into the closed topic itself, at most once per
   *  CLOSED_HINT_EVERY_MS per topic — the owner writes there, so says it there. */
  private closedHint(topic: string): void {
    const key = `topic:${topic}:closed_hint_at`
    if (Date.now() - Number(this.store.get(key) ?? 0) < CLOSED_HINT_EVERY_MS) return
    this.store.set(key, Date.now())
    void this.sendTopic(topic, t(this.cfg.lang, 'topic_closed_hint'))
      .catch(e => log('core', 'closed_hint_failed', { topic, err: describeError(e) }))
  }

  async notifyGeneral(text: string): Promise<void> {
    if (!this.isLocked()) return
    await this.sendTopic('general', text).catch(e => log('core', 'notify_failed', { err: describeError(e) }))
  }

  private ownMessage(topic: string, messageId: number): void {
    const owner = this.store.topicOfMessage(messageId)
    if (owner === undefined) throw new Error(`unknown message ${messageId} — not sent or received in this topic`)
    if (owner !== topic) throw new Error('message belongs to another topic')
  }

  /** Chat that holds a (possibly negated, see store) message id. */
  private chatOf(messageId: number): { chat: number; id: number } {
    return messageId < 0 ? { chat: this.sec!.owner_id!, id: -messageId } : { chat: this.sec!.chat_id!, id: messageId }
  }

  async sendTopic(topic: string, text: string, opts: SendOpts = {}): Promise<number[]> {
    if (!this.isLocked()) throw new Error('broker is not configured')
    const row = this.store.topic(topic)
    if (!row) throw new Error(`unknown topic ${topic}`)
    let replyTo = opts.reply_to
    if (replyTo !== undefined) {
      this.ownMessage(topic, replyTo)
      // A DM message cannot be quoted inside the group: send without a quote.
      if (replyTo < 0) replyTo = undefined
    }
    if (!text && !(opts.files?.length)) throw new Error('empty reply: pass text or files')
    const ids: number[] = []
    try {
      await this.tg.sendInto(row.chat_id, row.thread_id, text, {
        ...opts,
        reply_to: replyTo,
        onSent: id => {
          ids.push(id)
          this.store.rememberMessage(id, topic)
        },
      })
    } finally {
      log('core', 'sent', { topic, messages: ids.length, len: text.length, files: opts.files?.length ?? 0 })
    }
    return ids
  }

  // ---- tools -------------------------------------------------------------------

  private async handleTool(tool: ToolName, rawArgs: unknown, conn: ConnInfo): Promise<unknown> {
    const a = (rawArgs ?? {}) as Record<string, unknown>
    switch (tool) {
      case 'setup_token': return this.setup.setupToken(a)
      case 'setup_status': return this.setup.status()
      case 'reset': return this.setup.reset()
    }
    const topic = conn.topic
    if (conn.mode !== 'topic' || !topic) throw new Error('this connection is not bound to a topic')
    switch (tool) {
      case 'reply': {
        if (typeof a.text !== 'string') throw new Error('reply: text must be a string')
        const files = Array.isArray(a.files) ? (a.files as { name?: unknown; data_b64?: unknown }[]) : []
        for (const f of files) {
          if (typeof f?.name !== 'string' || typeof f.data_b64 !== 'string') throw new Error('reply: each file needs name and data_b64')
        }
        if (a.silent !== true) this.stopTyping(topic)
        this.store.set(`topic:${topic}:last_reply_at`, Date.now())
        const message_ids = await this.sendTopic(topic, a.text, {
          format: formatOf(a.format),
          silent: a.silent === true,
          reply_to: a.reply_to !== undefined && a.reply_to !== null ? toId(a.reply_to, 'reply_to') : undefined,
          files: files.map(f => ({ name: safeName(f.name as string)!, data_b64: f.data_b64 as string })),
        })
        return { message_ids }
      }
      case 'react': {
        const mid = toId(a.message_id, 'message_id')
        if (typeof a.emoji !== 'string' || !a.emoji) throw new Error('react: emoji must be a string')
        this.ownMessage(topic, mid)
        const { chat, id } = this.chatOf(mid)
        await this.tg.enqueue(chat, false, api =>
          api.setMessageReaction(chat, id, [{ type: 'emoji', emoji: a.emoji as never }]),
        )
        return { ok: true }
      }
      case 'edit_message': {
        const mid = toId(a.message_id, 'message_id')
        if (typeof a.text !== 'string' || !a.text) throw new Error('edit_message: text must be a non-empty string')
        this.ownMessage(topic, mid)
        const { chat, id } = this.chatOf(mid)
        const fmt = formatOf(a.format)
        const text = a.text as string
        if (fmt === 'markdown') {
          await this.tg.enqueue(chat, true, api => api.editMessageText(chat, id, mdToHtml(text).slice(0, MAX_TEXT_CHUNK), { parse_mode: 'HTML' }))
            .catch(e => {
              if (!isParseError(e)) throw e
              return this.tg.enqueue(chat, true, api => api.editMessageText(chat, id, text))
            })
        } else {
          const parse = fmt === 'markdownv2' ? { parse_mode: 'MarkdownV2' as const } : {}
          await this.tg.enqueue(chat, true, api => api.editMessageText(chat, id, text, parse))
        }
        return { message_id: mid }
      }
      case 'download_attachment': {
        if (typeof a.file_id !== 'string' || !a.file_id) throw new Error('download_attachment: file_id must be a string')
        return this.tg.download(a.file_id)
      }
    }
    for (const m of this.mods) {
      const h = m.tools?.[tool]
      if (h) return h(a, conn, this.ctxFor(m))
    }
    throw new Error(`${tool}: not implemented yet`)
  }
}

/** Telegram's Mini App signature check: secret = HMAC_SHA256("WebAppData",
 *  token); hash = HMAC_SHA256(secret, sorted "k=v" lines without hash).
 *  Returns the user id, or null when the data is forged or older than maxAgeS. */
export function verifyInitData(initData: string, token: string, maxAgeS = 24 * 3600, now = Date.now()): number | null {
  let p: URLSearchParams
  try {
    p = new URLSearchParams(initData)
  } catch {
    return null
  }
  const hash = p.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null
  const lines = [...p.entries()].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort()
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const want = createHmac('sha256', secret).update(lines.join('\n')).digest()
  const got = Buffer.from(hash, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  const at = Number(p.get('auth_date'))
  if (!Number.isFinite(at) || now / 1000 - at > maxAgeS) return null
  try {
    const id = JSON.parse(p.get('user') ?? '{}').id
    return typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

/** Who wrote a message the owner forwarded from elsewhere. */
export function forwardOrigin(m: Pick<Message, 'forward_origin'>): { from: string; date?: string } | undefined {
  const o = m.forward_origin
  if (!o) return undefined
  let from: string
  switch (o.type) {
    case 'user':
      from = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') +
        (o.sender_user.username ? ` (@${o.sender_user.username})` : '')
      break
    case 'hidden_user':
      from = o.sender_user_name
      break
    case 'chat':
      from = o.sender_chat.title ?? 'chat'
      break
    case 'channel':
      from = (o.chat.title ?? 'channel') + (o.author_signature ? ` — ${o.author_signature}` : '')
      break
    default:
      from = 'unknown'
  }
  return { from: (safeName(from) ?? '').slice(0, 200) || 'unknown', ...(o.date ? { date: new Date(o.date * 1000).toISOString() } : {}) }
}

/** reply/edit format; absent = markdown (the default since the UX block). */
function formatOf(v: unknown): Format {
  return v === 'text' || v === 'markdownv2' ? v : 'markdown'
}

function toId(v: unknown, name: string): number {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n === 0) throw new Error(`${name} must be a message id`)
  return n
}

/** Text + attachment meta of a content message, as the official plugin reads
 *  them; null for anything that is not owner content (service messages…). */
function contentOf(m: Message): { text: string; attachment?: Attachment } | null {
  const cap = m.caption
  if (m.photo?.length) {
    const best = m.photo[m.photo.length - 1]!
    return { text: cap ?? '(photo)', attachment: { kind: 'photo', file_id: best.file_id, ...(best.file_size ? { size: best.file_size } : {}) } }
  }
  if (m.document) {
    const name = safeName(m.document.file_name)
    return {
      text: cap ?? `(document: ${name ?? 'file'})`,
      attachment: { kind: 'document', file_id: m.document.file_id, size: m.document.file_size, mime: m.document.mime_type, name },
    }
  }
  if (m.voice) {
    return { text: cap ?? '(voice message)', attachment: { kind: 'voice', file_id: m.voice.file_id, size: m.voice.file_size, mime: m.voice.mime_type } }
  }
  if (m.audio) {
    const name = safeName(m.audio.file_name)
    return {
      text: cap ?? `(audio: ${safeName(m.audio.title) ?? name ?? 'audio'})`,
      attachment: { kind: 'audio', file_id: m.audio.file_id, size: m.audio.file_size, mime: m.audio.mime_type, name },
    }
  }
  if (m.video) {
    return {
      text: cap ?? '(video)',
      attachment: { kind: 'video', file_id: m.video.file_id, size: m.video.file_size, mime: m.video.mime_type, name: safeName(m.video.file_name) },
    }
  }
  if (m.video_note) {
    return { text: '(video note)', attachment: { kind: 'video_note', file_id: m.video_note.file_id, size: m.video_note.file_size } }
  }
  if (m.sticker) {
    const emoji = m.sticker.emoji ? ` ${m.sticker.emoji}` : ''
    return { text: `(sticker${emoji})`, attachment: { kind: 'sticker', file_id: m.sticker.file_id, size: m.sticker.file_size } }
  }
  if (typeof m.text === 'string') return { text: m.text }
  return null
}
// === GRACE END_BLOCK: broker_core =============================================
