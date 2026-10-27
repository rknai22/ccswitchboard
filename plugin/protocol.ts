// === GRACE START_BLOCK: ccswitchboard_protocol ================================
// MODULE_CONTRACT:
//   Wire contract between the channel shim (one per Claude session) and the
//   broker (the only holder of the bot token). NDJSON over TCP: one JSON
//   object per line, UTF-8, '\n'-terminated.
//   IN:  nothing — types and constants only; both sides import this file
//        (broker: ../plugin/protocol.ts), so it lives inside the plugin dir,
//        which Claude Code copies alone into its plugin cache.
//   INV: the shim never names a chat or a thread — the broker addresses every
//        send by the topic bound to the connection; edits and reactions are
//        accepted only for message_ids the broker recorded for that topic.
//   INV: files travel as bytes (base64) in both directions: shim and broker may
//        live on different machines and never share a filesystem.
//   INV: message ids are non-zero integers; a negative message_id means the
//        owner's private chat with the bot (so it never collides with a group
//        id). Opaque to the shim: pass it back as is.

export const PROTOCOL_VERSION = 1
export const DEFAULT_BROKER = '127.0.0.1:2223'
/** Telegram bot upload/download caps; checked on both sides. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_CHUNK = 4096

export type TopicTools = 'reply' | 'react' | 'edit_message' | 'download_attachment' | 'report' | 'tasks' | 'ask_owner' | 'tell_topic'
export type GeneralTools = 'create_topic' | 'forward' | 'propose_task'
export type SetupTools = 'setup_token' | 'setup_status' | 'reset'
export type ToolName = TopicTools | GeneralTools | SetupTools

// ---- handshake ---------------------------------------------------------------

/** What a shim understands beyond v1; old shims send none. */
export type Capability = 'ping' | 'redelivery'

/** First line from the shim. No key = setup mode (only SetupTools allowed).
 *  instance: random per shim process — tells a reconnect of the same process
 *  from a new process (a restarted session). */
export type Hello = { t: 'hello'; v: typeof PROTOCOL_VERSION; key?: string; instance?: string; caps?: Capability[] }

/** Broker answer to hello. `tools` is what this connection may call. */
export type Welcome = {
  t: 'welcome'
  mode: 'topic' | 'setup'
  /** Topic name (e.g. "general", "wms"); absent in setup mode. */
  topic?: string
  tools: ToolName[]
}

/** Broker refuses the connection and closes it (bad key, closed topic, version). */
export type Reject = { t: 'reject'; reason: string }

// ---- inbound messages --------------------------------------------------------

export type Attachment = {
  kind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'sticker'
  file_id: string
  size?: number
  mime?: string
  /** Uploader-controlled: broker strips <>[]\r\n; before sending. */
  name?: string
}

/** One owner message for this topic. Delivered at least once, in update_id order. */
export type InboundEvent = {
  t: 'event'
  update_id: number
  topic: string
  /** Negative = the owner's private chat (see MODULE_CONTRACT). */
  message_id: number
  user: string
  user_id: string
  /** ISO 8601 */
  ts: string
  text: string
  attachment?: Attachment
  /** Present when the general session forwarded the owner's words here. */
  forwarded_from_general?: { message_id: number }
  /** Present when the owner quote-replied to an earlier message. */
  reply_to?: { message_id: number; text?: string }
  /** The owner forwarded this from another chat: who wrote it (cleaned of
   *  tag delimiters by the broker) and when (ISO 8601). */
  forwarded_from?: { from: string; date?: string }
  /** A task the owner approved (propose_task → button) or that this message
   *  belongs to. */
  task_id?: number
  /** Another topic's session wrote this (tell_topic): information, not an order. */
  from_topic?: string
  /** The owner pressed a button of an ask_owner question. */
  answer_to?: { question_id: number; question: string }
  /** Sent again to a new shim instance: the previous one acked it, but its
   *  session may have died before Claude kept it. Only to caps 'redelivery'. */
  redelivered?: true
}

/** Shim confirms it handed the event to Claude; broker marks it delivered. */
export type Ack = { t: 'ack'; update_id: number }

/** Broker → shim: the binding is gone (topic closed/deleted, setup reset). */
export type Unbound = { t: 'unbound'; reason: string }

/** Broker → shim (caps 'ping'): are you alive? Asked before another hello
 *  with the same key may take the topic. */
export type Ping = { t: 'ping'; nonce: string }

/** Shim → broker: answer to ping, same nonce. */
export type Pong = { t: 'pong'; nonce: string }

// ---- tool calls ----------------------------------------------------------------

export type FilePayload = { name: string; data_b64: string }

/** markdown: the broker's small dialect → Telegram HTML (see broker/src/markdown.ts). */
export type Format = 'text' | 'markdownv2' | 'markdown'

export type CallArgs = {
  reply: { text: string; reply_to?: number; files?: FilePayload[]; format?: Format; silent?: boolean }
  react: { message_id: number; emoji: string }
  edit_message: { message_id: number; text: string; format?: Format }
  download_attachment: { file_id: string }
  /** General only. name: [a-z0-9-]{1,32}; title: shown in Telegram. */
  create_topic: { name: string; title?: string }
  /** General only. source_message_id must be an owner message in general. */
  forward: { topic: string; source_message_id: number }
  /** General only: a task for a topic, sent there only after the owner's button. */
  propose_task: { topic: string; title: string; spec: string }
  /** A topic's own task: progress or a new task (title, no task_id). */
  report: { task_id?: number; title?: string; state: TaskState; summary: string; next_step?: string }
  tasks: { topic?: string; open_only?: boolean }
  ask_owner: { question: string; options?: string[] }
  tell_topic: { topic: string; text: string }
  setup_token: { token: string }
  setup_status: Record<string, never>
  reset: Record<string, never>
}

export type CallResults = {
  reply: { message_ids: number[] }
  react: { ok: true }
  edit_message: { message_id: number }
  download_attachment: FilePayload & { mime?: string }
  create_topic: { name: string; thread_id: number; cwd: string }
  forward: { message_id: number }
  propose_task: { task_id: number; message_id: number }
  report: { task_id: number; state: TaskState }
  tasks: { tasks: TaskView[] }
  ask_owner: { question_id: number; message_id: number }
  tell_topic: { message_id: number }
  setup_token: { bot_username: string }
  setup_status: SetupStatus
  reset: { sent: true }
}

export type TaskState = 'proposed' | 'assigned' | 'in_progress' | 'waiting_owner' | 'blocked' | 'done' | 'cancelled'

export type TaskView = {
  id: number
  topic: string
  title: string
  state: TaskState
  source: 'general' | 'topic'
  summary: string | null
  next_step: string | null
  /** minutes since the last report (or since creation) */
  report_age_min: number
  session_connected: boolean
  session_busy: boolean
}

export type SetupState = 'unconfigured' | 'waiting_chat' | 'waiting_button' | 'locked'

export type SetupStatus = {
  state: SetupState
  bot_username?: string
  chat_title?: string
  /** Human hint for the wizard, e.g. "turn on topics in the group settings". */
  hint?: string
}

export type Call<T extends ToolName = ToolName> = { t: 'call'; id: string; tool: T; args: CallArgs[T] }

export type Result<T extends ToolName = ToolName> =
  | { t: 'result'; id: string; ok: true; data: CallResults[T] }
  | { t: 'result'; id: string; ok: false; error: string }

export type ShimToBroker = Hello | Ack | Call | Pong
export type BrokerToShim = Welcome | Reject | InboundEvent | Unbound | Result | Ping

// ---- framing -------------------------------------------------------------------

export function encode(msg: ShimToBroker | BrokerToShim): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Incremental NDJSON splitter. Feed raw chunks; returns complete parsed lines.
 * Bad JSON lines are reported through onBad and skipped — one corrupt line must
 * not kill a long-lived connection.
 */
export class LineDecoder {
  // Partial line kept as pieces and searched chunk by chunk: a file payload
  // is one line of tens of MB, and re-scanning (and re-flattening) the whole
  // buffer on every 64 KB chunk would make it quadratic.
  private parts: string[] = []
  private size = 0
  constructor(private onBad: (line: string, err: unknown) => void = () => {}) {}
  push(chunk: string): unknown[] {
    const out: unknown[] = []
    let start = 0
    let i: number
    while ((i = chunk.indexOf('\n', start)) >= 0) {
      this.parts.push(chunk.slice(start, i))
      const line = this.parts.join('')
      this.parts = []
      this.size = 0
      start = i + 1
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch (e) {
        this.onBad(line, e)
      }
    }
    if (start < chunk.length) {
      this.parts.push(chunk.slice(start))
      this.size += chunk.length - start
    }
    return out
  }
  /** Characters buffered for the unfinished line — lets a reader cap it. */
  get pending(): number {
    return this.size
  }
}

export function parseBrokerAddr(s: string | undefined): { host: string; port: number } {
  const v = (s ?? DEFAULT_BROKER).trim()
  const i = v.lastIndexOf(':')
  const port = Number(v.slice(i + 1))
  if (i <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`bad broker address: ${v} (want host:port)`)
  }
  return { host: v.slice(0, i), port }
}
// === GRACE END_BLOCK: ccswitchboard_protocol ==================================
