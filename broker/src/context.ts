// === GRACE START_BLOCK: broker_context ========================================
// MODULE_CONTRACT:
//   IN:  nothing at runtime — types plus the shared LDD logger.
//   OUT: BrokerModule (the extension point wave-B features plug into),
//        BrokerContext (what the core hands them), ConnInfo, log().
//   INV: modules never get the bot token or a raw socket: they send through
//        the core's queue (rate limit + message → topic bookkeeping) and touch
//        connections only through unbind().
//   INV: log lines carry ids and lengths, never the token, topic keys or
//        message texts.

import type { Api } from 'grammy'
import type { Update } from 'grammy/types'
import type { FilePayload, InboundEvent, ToolName } from '../../plugin/protocol.ts'
import type { Config } from './config.ts'
import type { Store, StoredEvent } from './store.ts'

export type LogFields = Record<string, string | number | boolean | null | undefined>

/** One JSON line per event on stderr: {"ts","mod","ev",...}. */
export function log(mod: string, ev: string, fields: LogFields = {}): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), mod, ev, ...fields }) + '\n')
}

export type ConnInfo = {
  id: number
  mode: 'topic' | 'setup'
  /** Bound topic name; absent in setup mode. */
  topic?: string
}

export type SendOpts = {
  format?: 'text' | 'markdownv2'
  /** message_id in the same topic to quote-reply (first chunk only). */
  reply_to?: number
  files?: FilePayload[]
  /** Telegram disable_notification — e.g. the pinned limits message. */
  silent?: boolean
  reply_markup?: unknown
}

export type TgFacade = {
  /** Sends text (split at 4096) and files into a topic; returns all message ids. */
  send(topic: string, text: string, opts?: SendOpts): Promise<number[]>
  /** Runs an arbitrary Bot API call through the group's ordered, rate-limited
   *  queue. `message: true` counts it against the 1/s and 20/min limits. */
  call<T>(fn: (api: Api) => Promise<T>, opts?: { message?: boolean }): Promise<T>
  /** Current Api (null before setup_token / after reset) for calls that need
   *  no ordering, e.g. getChat. */
  api(): Api | null
}

export type BrokerContext = {
  config: Config
  store: Store
  tg: TgFacade
  /** Put an event into a topic's queue locally (forwards, wake-ups); the
   *  broker assigns the update_id. */
  enqueueEvent(topic: string, ev: Omit<InboundEvent, 't' | 'update_id' | 'topic'>): StoredEvent
  /** Plain message to the group's General topic; no-op before setup is locked. */
  notifyGeneral(text: string): Promise<void>
  log(ev: string, fields?: LogFields): void
  isLocked(): boolean
  /** owner_id and chat_id once locked. */
  owner(): { owner_id: number; chat_id: number } | null
  /** Tell the topic's connected shim it is no longer bound (topic closed). */
  unbind(topic: string, reason: string): void
  /** A shim holding this topic's key is connected and bound right now. */
  isConnected(topic: string): boolean
  /** When (epoch ms) the topic's current shim connection was welcomed; null
   *  when none is bound. */
  connectedSince(topic: string): number | null
}

export type BrokerModule = {
  name: string
  start?(ctx: BrokerContext): void | Promise<void>
  /** raw Telegram update after the core saw it; return true if handled */
  onUpdate?(u: Update, ctx: BrokerContext): boolean | Promise<boolean>
  onLocked?(ctx: BrokerContext): void | Promise<void>
  /** handlers for tools the core leaves to modules (create_topic, forward) */
  tools?: Partial<Record<ToolName, (args: any, conn: ConnInfo, ctx: BrokerContext) => Promise<unknown>>>
}
// === GRACE END_BLOCK: broker_context ==========================================
