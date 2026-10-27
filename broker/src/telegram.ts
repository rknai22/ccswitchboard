// === GRACE START_BLOCK: broker_telegram =======================================
// MODULE_CONTRACT:
//   IN:  bot token (from secret.json, may be absent), api_root from config,
//        an onUpdate handler that commits each update (and its offset).
//   OUT: long-poll loop (getUpdates, 30 s), per-chat ordered send queue with
//        the group limits (1 message/s, 20/min, 429 → retry_after), chunked
//        text, file upload/download as bytes.
//   INV: the broker is the only getUpdates consumer; on 409 it backs off 30 s
//        and keeps trying instead of fighting or exiting — the owner is told
//        (rate-limited by the caller) and decides which instance should live.
//   INV: no error kills the loop: network/5xx back off up to 60 s, a revoked
//        token waits 60 s (reset happens through the CLI), a bad update is
//        logged and skipped by the handler.
//   INV: only 429 is retried for sends — Telegram guarantees nothing was sent;
//        retrying a network failure could post the same message twice.

import { Api, GrammyError, HttpError, InputFile } from 'grammy'
import type { Update } from 'grammy/types'
import { MAX_DOWNLOAD_BYTES, MAX_TEXT_CHUNK, MAX_UPLOAD_BYTES, type FilePayload, type Format } from '../../plugin/protocol.ts'
import { AS_FILE_CHARS, mdChunks, mdToHtml } from './markdown.ts'
import { botIdOf, type Config } from './config.ts'
import { log } from './context.ts'
import type { Store } from './store.ts'

export type AllowedUpdate = 'message' | 'callback_query' | 'my_chat_member'

export type PollHooks = {
  /** Must commit the update's offset (alone or with the event it produced). */
  onUpdate(u: Update): Promise<void>
  onConflict(description: string): void
  allowedUpdates(): AllowedUpdate[]
}

const POLL_TIMEOUT_S = 30
const CONFLICT_PAUSE_MS = 30_000
const MAX_BACKOFF_MS = 60_000
const MSG_GAP_MS = 1000
const MSG_PER_MIN = 20

// .jpg/.jpeg/.png/.gif/.webp go as photos (inline preview), the rest as
// documents — same split as the official plugin.
const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(res => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
  })

/** Split at ≤ limit, preferring paragraph, then line, then word boundaries. */
/** Telegram refused the entities/HTML of a message. */
export function isParseError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /can't parse entities|unsupported start tag|can't find end/i.test(e.description)
}

export function chunk(text: string, limit = MAX_TEXT_CHUNK): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export function describeError(e: unknown): string {
  if (e instanceof GrammyError) return `${e.error_code}: ${e.description}`
  if (e instanceof HttpError) return `network: ${String((e.error as Error)?.message ?? e.error)}`
  return e instanceof Error ? e.message : String(e)
}

export class Telegram {
  private token: string | null = null
  private apiObj: Api | null = null
  private pollCtl: AbortController | null = null
  private chains = new Map<string, Promise<unknown>>()
  private sentAt = new Map<string, number[]>()

  constructor(private cfg: Config, private store: Store, private hooks: PollHooks) {}

  newApi(token: string): Api {
    return new Api(token, { apiRoot: this.cfg.api_root })
  }

  api(): Api | null {
    return this.apiObj
  }

  botId(): string | null {
    return this.token ? botIdOf(this.token) : null
  }

  /** Switch bots (or drop the token on reset). Stops any running poll. */
  setToken(token: string | null): void {
    if (token === this.token) return
    this.stopPolling()
    this.token = token
    this.apiObj = token ? this.newApi(token) : null
  }

  isPolling(): boolean {
    return this.pollCtl !== null
  }

  startPolling(): void {
    if (!this.apiObj || this.pollCtl) return
    const ctl = new AbortController()
    this.pollCtl = ctl
    void this.pollLoop(this.apiObj, botIdOf(this.token!), ctl.signal)
  }

  stopPolling(): void {
    this.pollCtl?.abort()
    this.pollCtl = null
  }

  /** Abort the current long poll so a changed allowed_updates list applies now. */
  repoll(): void {
    if (!this.pollCtl) return
    this.stopPolling()
    this.startPolling()
  }

  private async pollLoop(api: Api, botId: string, signal: AbortSignal): Promise<void> {
    log('tg', 'poll_start', { bot_id: botId })
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const offset = this.store.getOffset(botId)
        const updates = await api.getUpdates(
          { ...(offset !== undefined ? { offset } : {}), timeout: POLL_TIMEOUT_S, allowed_updates: this.hooks.allowedUpdates() },
          // grammY's Node typings use the abort-controller polyfill's type;
          // Bun's native AbortSignal is what it actually accepts at runtime.
          signal as never,
        )
        backoff = 1000
        for (const u of updates) {
          if (signal.aborted) break
          try {
            await this.hooks.onUpdate(u)
          } catch (e) {
            // A poison update must not block the queue forever: log, skip it.
            log('tg', 'update_failed', { update_id: u.update_id, err: describeError(e) })
            this.store.setOffset(botId, u.update_id + 1)
          }
        }
      } catch (e) {
        if (signal.aborted) break
        if (e instanceof GrammyError && e.error_code === 409) {
          log('tg', 'poll_conflict', { bot_id: botId, webhook: /webhook/i.test(e.description) })
          this.hooks.onConflict(e.description)
          await sleep(CONFLICT_PAUSE_MS, signal)
        } else if (e instanceof GrammyError && (e.error_code === 401 || e.error_code === 404)) {
          log('tg', 'poll_unauthorized', { bot_id: botId, code: e.error_code })
          await sleep(MAX_BACKOFF_MS, signal)
        } else if (e instanceof GrammyError && e.error_code === 429) {
          await sleep((e.parameters.retry_after ?? 5) * 1000, signal)
        } else {
          log('tg', 'poll_error', { bot_id: botId, err: describeError(e), retry_ms: backoff })
          await sleep(backoff, signal)
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        }
      }
    }
    log('tg', 'poll_stop', { bot_id: botId })
  }

  // ---- outbound queue ------------------------------------------------------------

  /**
   * Run fn after everything queued earlier for this chat. `message` calls wait
   * for the group limits first. 429 → sleep retry_after and retry the same call.
   */
  enqueue<T>(chatId: number, message: boolean, fn: (api: Api) => Promise<T>): Promise<T> {
    const key = String(chatId)
    const prev = this.chains.get(key) ?? Promise.resolve()
    const run = prev.then(async () => {
      if (message) await this.waitSlot(key)
      for (let attempt = 1; ; attempt++) {
        const api = this.apiObj
        if (!api) throw new Error('broker is not configured')
        try {
          return await fn(api)
        } catch (e) {
          if (e instanceof GrammyError && e.error_code === 429 && attempt < 5) {
            const s = e.parameters.retry_after ?? 5
            log('tg', 'rate_limited', { chat_id: chatId, retry_after: s, method: e.method })
            await sleep(s * 1000)
            continue
          }
          throw e
        }
      }
    })
    this.chains.set(key, run.catch(() => {}))
    return run
  }

  private async waitSlot(key: string): Promise<void> {
    for (;;) {
      const now = Date.now()
      const ts = (this.sentAt.get(key) ?? []).filter(x => now - x < 60_000)
      this.sentAt.set(key, ts)
      const last = ts[ts.length - 1]
      let wait = 0
      if (last !== undefined && now - last < MSG_GAP_MS) wait = MSG_GAP_MS - (now - last)
      if (ts.length >= MSG_PER_MIN) wait = Math.max(wait, ts[0]! + 60_000 - now)
      if (wait <= 0) {
        ts.push(now)
        return
      }
      await sleep(wait)
    }
  }

  // ---- high-level sends ------------------------------------------------------------

  /** Text in chunks, then files; returns every message id in order. */
  async sendInto(
    chatId: number,
    threadId: number | null,
    text: string,
    opts: {
      format?: Format; reply_to?: number; files?: FilePayload[]; silent?: boolean; reply_markup?: unknown
      /** Called per sent message, so a failure halfway still records what went out. */
      onSent?: (id: number) => void
    },
  ): Promise<number[]> {
    let files = opts.files ?? []
    const md = opts.format === 'markdown'
    if (md && text.length > AS_FILE_CHARS) {
      // Too long to read as messages: the start here, everything in a file.
      files = [{ name: 'reply.md', data_b64: Buffer.from(text).toString('base64') }, ...files]
      text = `${mdChunks(text)[0] ?? ''}\n\n…`
    }
    const decoded = files.map(f => {
      const buf = Buffer.from(f.data_b64, 'base64')
      if (buf.length > MAX_UPLOAD_BYTES) {
        throw new Error(`file too large: ${f.name} (${(buf.length / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
      }
      return { name: f.name, buf }
    })
    const base = {
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
    }
    const parse = opts.format === 'markdownv2' ? { parse_mode: 'MarkdownV2' as const } : md ? { parse_mode: 'HTML' as const } : {}
    const replyTo = opts.reply_to !== undefined ? { reply_parameters: { message_id: opts.reply_to } } : {}
    const plain = !text.length ? [] : md ? mdChunks(text) : chunk(text)
    const chunks = md ? plain.map(mdToHtml) : plain
    const ids: number[] = []
    try {
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1
        const extra = {
          ...base, ...(i === 0 ? replyTo : {}),
          ...(last && opts.reply_markup ? { reply_markup: opts.reply_markup as never } : {}),
        }
        const m = await this.enqueue(chatId, true, api => api.sendMessage(chatId, chunks[i]!, { ...extra, ...parse }))
          .catch(async e => {
            // Markup Telegram cannot parse: the same piece as plain text.
            if (!md || !isParseError(e)) throw e
            log('tg', 'markup_fallback', { len: plain[i]!.length })
            return this.enqueue(chatId, true, api => api.sendMessage(chatId, plain[i]!, extra))
          })
        ids.push(m.message_id)
        opts.onSent?.(m.message_id)
      }
    } catch (e) {
      throw new Error(`reply failed after ${ids.length} of ${chunks.length} chunk(s) sent: ${describeError(e)}`)
    }
    for (const f of decoded) {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase()
      const input = new InputFile(f.buf, f.name)
      try {
        const m = await this.enqueue<{ message_id: number }>(chatId, true, api =>
          PHOTO_EXTS.has(ext)
            ? api.sendPhoto(chatId, input, { ...base, ...replyTo })
            : api.sendDocument(chatId, input, { ...base, ...replyTo }),
        )
        ids.push(m.message_id)
        opts.onSent?.(m.message_id)
      } catch (e) {
        throw new Error(`file ${f.name} failed after ${ids.length} message(s) sent: ${describeError(e)}`)
      }
    }
    return ids
  }

  /** Fetch a file Telegram holds for us, as bytes (bots may download ≤ 20 MB). */
  async download(fileId: string): Promise<FilePayload> {
    const api = this.apiObj
    if (!api || !this.token) throw new Error('broker is not configured')
    const file = await api.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
    if (file.file_size !== undefined && file.file_size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`file too large for a bot download: ${(file.file_size / 1024 / 1024).toFixed(1)}MB, max 20MB`)
    }
    const res = await fetch(`${this.cfg.api_root}/file/bot${this.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('file too large for a bot download (max 20MB)')
    // file_path is Telegram's, but strip to safe chars so nothing downstream
    // can be tricked by an unexpected extension (as upstream does).
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const uniq = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    return { name: `${Date.now()}-${uniq}.${ext}`, data_b64: buf.toString('base64') }
  }
}
// === GRACE END_BLOCK: broker_telegram =========================================
