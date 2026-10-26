// === GRACE START_BLOCK: broker_setup ==========================================
// MODULE_CONTRACT:
//   IN:  setup tools from keyless shim connections (setup_token, setup_status,
//        reset); my_chat_member and ccsb:* callback updates from the poller.
//   OUT: the setup state machine
//          unconfigured → (setup_token) → waiting_chat → (bot made admin in a
//          forum supergroup with topic+pin rights) → waiting_button → (someone
//          presses "Yes, it's ours" within 30 min) → locked;
//        reset: a button in General (10 min, owner only) or the CLI wipes
//          secret.json and the registry → unconfigured.
//   INV: secret.json.locked is the source of truth for "configured"; kv keeps
//        only the in-between states, so a wiped kv can never unlock a broker.
//   INV: once locked, setup_token is refused — changing the bot or the group
//        needs the owner's button press (or root on the broker machine).
//   INV: whoever presses the claim button becomes owner_id: that press is the
//        proof of being in the group, replacing upstream's DM pairing codes.

import { randomBytes } from 'crypto'
import { GrammyError } from 'grammy'
import type { ChatMember, Update } from 'grammy/types'
import type { CallResults, SetupState, SetupStatus } from '../../plugin/protocol.ts'
import { deleteSecret, type Config, type Secret } from './config.ts'
import { log } from './context.ts'
import type { Store } from './store.ts'
import { t, type StringKey } from './strings.ts'
import { describeError, type Telegram } from './telegram.ts'

const CLAIM_TTL_MS = 30 * 60_000
const RESET_TTL_MS = 10 * 60_000
const RECHECK_MIN_MS = 5_000

export type SetupHost = {
  cfg: Config
  store: Store
  tg: Telegram
  secret(): Secret | null
  /** Persist (or delete) the secret and point the poller at its token. */
  saveSecret(s: Secret | null): void
  /** Send into the General topic of the locked group, recording msg_topic. */
  sendGeneral(text: string, markup?: unknown): Promise<number>
  onLocked(): Promise<void>
  /** Drop every topic binding after a reset. */
  onReset(): void
}

/** Wipe the setup: used by the reset button and by `reset` on the CLI. Folders
 *  and sessions live elsewhere and are left alone. */
export function wipeSetup(cfg: Config, store: Store): void {
  store.wipe()
  deleteSecret(cfg)
}

export class Setup {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRecheck = 0

  constructor(private h: SetupHost) {}

  private get lang() { return this.h.cfg.lang }
  private get kv() { return this.h.store }

  start(): void {
    this.timer = setInterval(() => void this.expire().catch(e => log('setup', 'expire_failed', { err: describeError(e) })), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  state(): SetupState {
    const s = this.h.secret()
    if (!s) return 'unconfigured'
    if (s.locked) return 'locked'
    return this.kv.get('setup_state') === 'waiting_button' ? 'waiting_button' : 'waiting_chat'
  }

  // ---- tools -------------------------------------------------------------------

  async setupToken(args: { token?: unknown }): Promise<CallResults['setup_token']> {
    if (this.state() === 'locked') throw new Error(t(this.lang, 'already_locked'))
    const token = typeof args.token === 'string' ? args.token.trim() : ''
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error(t(this.lang, 'token_rejected'))
    let username: string
    try {
      const me = await this.h.tg.newApi(token).getMe()
      username = me.username
    } catch (e) {
      if (e instanceof GrammyError && (e.error_code === 401 || e.error_code === 404)) {
        log('setup', 'token_rejected', { code: e.error_code })
        throw new Error(t(this.lang, 'token_rejected'))
      }
      throw new Error(t(this.lang, 'telegram_unreachable', { err: describeError(e) }))
    }
    const prev = this.h.secret()
    const sameBot = prev?.bot_token === token
    // A different bot cannot use the old candidate group or claim button.
    this.kv.del('claim_nonce', 'claim_chat', 'claim_expires', 'claim_msg')
    if (!sameBot) this.kv.del('candidate_chat', 'chat_title')
    this.kv.set('setup_state', 'waiting_chat')
    this.kv.set('bot_username', username)
    this.kv.set('hint', 'hint_add_bot')
    this.h.saveSecret({ bot_token: token, locked: false })
    log('setup', 'token_accepted', { same_bot: sameBot })
    // Sending the token again is also the way to get a fresh claim button.
    const cand = this.kv.get('candidate_chat')
    if (sameBot && cand) await this.evaluate(Number(cand)).catch(e => log('setup', 'evaluate_failed', { err: describeError(e) }))
    return { bot_username: username }
  }

  async status(): Promise<SetupStatus> {
    const st = this.state()
    // Turning topics on (or granting rights) does not always send the bot an
    // update, so the wizard's polling re-checks the group it already knows.
    const hint = this.kv.get('hint')
    const cand = this.kv.get('candidate_chat')
    if (st === 'waiting_chat' && cand && hint !== 'hint_button_expired' && Date.now() - this.lastRecheck > RECHECK_MIN_MS) {
      this.lastRecheck = Date.now()
      await this.evaluate(Number(cand)).catch(e => log('setup', 'evaluate_failed', { err: describeError(e) }))
    }
    const now = this.state()
    const out: SetupStatus = { state: now }
    const bot = this.kv.get('bot_username')
    const title = this.kv.get('chat_title')
    const h = this.kv.get('hint')
    if (bot && now !== 'unconfigured') out.bot_username = bot
    if (title && now !== 'unconfigured') out.chat_title = title
    if (h && now !== 'locked' && now !== 'unconfigured') out.hint = t(this.lang, h as StringKey)
    return out
  }

  async reset(): Promise<CallResults['reset']> {
    if (this.state() !== 'locked') throw new Error(t(this.lang, 'reset_not_configured'))
    const nonce = randomBytes(9).toString('base64url')
    const markup = { inline_keyboard: [[{ text: t(this.lang, 'reset_button'), callback_data: `ccsb:reset:${nonce}` }]] }
    const msgId = await this.h.sendGeneral(t(this.lang, 'reset_question'), markup)
    // A newer request replaces the older button: only the latest nonce counts.
    this.kv.set('reset_nonce', nonce)
    this.kv.set('reset_expires', Date.now() + RESET_TTL_MS)
    this.kv.set('reset_msg', msgId)
    log('setup', 'reset_requested', { message_id: msgId })
    return { sent: true }
  }

  // ---- updates -----------------------------------------------------------------

  /** Returns true when the update was a setup update (and is fully handled). */
  async onUpdate(u: Update): Promise<boolean> {
    if (u.callback_query?.data?.startsWith('ccsb:')) {
      await this.onCallback(u.callback_query)
      return true
    }
    if (u.my_chat_member) {
      const st = this.state()
      if (st !== 'waiting_chat' && st !== 'waiting_button') return false
      await this.onMyChatMember(u.my_chat_member)
      return true
    }
    return false
  }

  private async onMyChatMember(m: NonNullable<Update['my_chat_member']>): Promise<void> {
    const chat = m.chat
    if (chat.type === 'private' || chat.type === 'channel') return
    const status = m.new_chat_member.status
    log('setup', 'my_chat_member', { chat_id: chat.id, chat_type: chat.type, status })
    if (status !== 'administrator') {
      if (String(chat.id) === this.kv.get('candidate_chat')) {
        if (this.kv.get('claim_chat') === String(chat.id)) await this.dropClaim('claim_expired')
        this.kv.set('setup_state', 'waiting_chat')
        this.kv.set('hint', 'hint_add_bot')
      }
      return
    }
    this.kv.set('candidate_chat', chat.id)
    if ('title' in chat && chat.title) this.kv.set('chat_title', chat.title)
    await this.evaluate(chat.id, m.new_chat_member)
  }

  /** Is this chat ready for the claim button? Sets a hint if not. */
  private async evaluate(chatId: number, member?: ChatMember): Promise<void> {
    const api = this.h.tg.api()
    if (!api) return
    let chat
    try {
      chat = await api.getChat(chatId)
    } catch (e) {
      // Turning topics on in a basic group migrates it to a new supergroup id.
      const to = e instanceof GrammyError ? e.parameters.migrate_to_chat_id : undefined
      if (to === undefined) throw e
      log('setup', 'chat_migrated', { from: chatId, to })
      this.kv.set('candidate_chat', to)
      chatId = to
      member = undefined
      chat = await api.getChat(chatId)
    }
    if (chat.title) this.kv.set('chat_title', chat.title)
    if (chat.type !== 'supergroup' || !chat.is_forum) return this.hint('hint_no_forum')
    const me = member ?? await api.getChatMember(chatId, Number(this.h.tg.botId()))
    if (me.status !== 'administrator') return this.hint('hint_add_bot')
    if (!me.can_manage_topics || !me.can_pin_messages) return this.hint('hint_rights')
    const live = this.kv.get('claim_chat') === String(chatId) && Number(this.kv.get('claim_expires') ?? 0) > Date.now()
    if (this.state() === 'waiting_button' && live) return
    await this.sendClaim(chatId)
  }

  private hint(key: StringKey): void {
    this.kv.set('hint', key)
    if (this.state() === 'waiting_button') return
    this.kv.set('setup_state', 'waiting_chat')
  }

  private async sendClaim(chatId: number): Promise<void> {
    await this.dropClaim('claim_expired')
    const nonce = randomBytes(9).toString('base64url')
    const markup = { inline_keyboard: [[{ text: t(this.lang, 'claim_button'), callback_data: `ccsb:claim:${nonce}` }]] }
    const m = await this.h.tg.enqueue(chatId, true, api =>
      api.sendMessage(chatId, t(this.lang, 'claim_question'), { reply_markup: markup }),
    )
    this.kv.set('claim_nonce', nonce)
    this.kv.set('claim_chat', chatId)
    this.kv.set('claim_expires', Date.now() + CLAIM_TTL_MS)
    this.kv.set('claim_msg', m.message_id)
    this.kv.set('setup_state', 'waiting_button')
    this.kv.set('hint', 'hint_press_button')
    log('setup', 'claim_sent', { chat_id: chatId, message_id: m.message_id })
  }

  /** Retire an outstanding claim button (edit its message, forget its nonce). */
  private async dropClaim(textKey: StringKey): Promise<void> {
    const chat = this.kv.get('claim_chat')
    const msg = this.kv.get('claim_msg')
    this.kv.del('claim_nonce', 'claim_chat', 'claim_expires', 'claim_msg')
    if (chat && msg) {
      await this.h.tg.enqueue(Number(chat), true, api =>
        api.editMessageText(Number(chat), Number(msg), t(this.lang, textKey)),
      ).catch(e => log('setup', 'edit_failed', { err: describeError(e) }))
    }
  }

  private async answer(id: string, key?: StringKey): Promise<void> {
    await this.h.tg.api()?.answerCallbackQuery(id, key ? { text: t(this.lang, key) } : {})
      .catch(e => log('setup', 'answer_failed', { err: describeError(e) }))
  }

  private async onCallback(cq: NonNullable<Update['callback_query']>): Promise<void> {
    const data = cq.data ?? ''
    const chatId = cq.message?.chat.id
    const claim = /^ccsb:claim:([A-Za-z0-9_-]+)$/.exec(data)
    if (claim) {
      const nonce = this.kv.get('claim_nonce')
      if (this.state() !== 'waiting_button' || !nonce || nonce !== claim[1] || String(chatId) !== this.kv.get('claim_chat')) {
        log('setup', 'claim_ignored', { from: cq.from.id, chat_id: chatId ?? null })
        return this.answer(cq.id, 'callback_expired')
      }
      if (Number(this.kv.get('claim_expires') ?? 0) < Date.now()) {
        await this.expireClaim()
        return this.answer(cq.id, 'callback_expired')
      }
      return this.lock(cq.id, cq.from, chatId!)
    }
    const reset = /^ccsb:reset:([A-Za-z0-9_-]+)$/.exec(data)
    if (reset) {
      const s = this.h.secret()
      // Only the owner may reset; anyone else's press just stops the spinner.
      if (!s?.locked || cq.from.id !== s.owner_id || chatId !== s.chat_id) {
        log('setup', 'reset_ignored', { from: cq.from.id })
        return this.answer(cq.id)
      }
      const nonce = this.kv.get('reset_nonce')
      if (!nonce || nonce !== reset[1] || Number(this.kv.get('reset_expires') ?? 0) < Date.now()) {
        log('setup', 'reset_stale', { from: cq.from.id })
        return this.answer(cq.id, 'callback_expired')
      }
      await this.answer(cq.id, 'callback_done')
      const msg = cq.message?.message_id
      if (msg !== undefined) {
        await this.h.tg.enqueue(s.chat_id!, true, api =>
          api.editMessageText(s.chat_id!, msg, t(this.lang, 'reset_done')),
        ).catch(e => log('setup', 'edit_failed', { err: describeError(e) }))
      }
      this.doReset('reset by owner')
      return
    }
    return this.answer(cq.id)
  }

  private async lock(cbId: string, from: { id: number; username?: string; first_name: string }, chatId: number): Promise<void> {
    const msg = Number(this.kv.get('claim_msg'))
    const prev = this.h.secret()!
    const store = this.h.store
    // Registry first, secret last: a crash in between leaves the broker
    // unlocked (secret.json is the truth) and the next claim re-creates general.
    store.db.transaction(() => {
      store.db.query("DELETE FROM topics WHERE name = 'general'").run()
      store.createTopic({ name: 'general', chat_id: chatId, thread_id: null, title: t(this.lang, 'general_title') })
      if (msg) store.rememberMessage(msg, 'general')
      store.set('setup_state', 'locked')
      store.del('claim_nonce', 'claim_chat', 'claim_expires', 'claim_msg', 'candidate_chat', 'hint')
    })()
    this.h.saveSecret({ bot_token: prev.bot_token, owner_id: from.id, chat_id: chatId, locked: true })
    log('setup', 'locked', { owner_id: from.id, chat_id: chatId })
    await this.answer(cbId, 'callback_done')
    if (msg) {
      const owner = from.username ? `@${from.username}` : from.first_name
      await this.h.tg.enqueue(chatId, true, api =>
        api.editMessageText(chatId, msg, t(this.lang, 'claim_done', { owner })),
      ).catch(e => log('setup', 'edit_failed', { err: describeError(e) }))
    }
    this.h.tg.repoll()
    await this.h.onLocked()
  }

  private async expireClaim(): Promise<void> {
    await this.dropClaim('claim_expired')
    this.kv.set('setup_state', 'waiting_chat')
    this.kv.set('hint', 'hint_button_expired')
    log('setup', 'claim_expired')
  }

  private async expire(): Promise<void> {
    const now = Date.now()
    if (this.state() === 'waiting_button' && Number(this.kv.get('claim_expires') ?? 0) < now) await this.expireClaim()
    const resetExp = this.kv.get('reset_expires')
    if (resetExp && Number(resetExp) < now) {
      const msg = this.kv.get('reset_msg')
      const s = this.h.secret()
      this.kv.del('reset_nonce', 'reset_expires', 'reset_msg')
      if (msg && s?.chat_id) {
        await this.h.tg.enqueue(s.chat_id, true, api =>
          api.editMessageText(s.chat_id!, Number(msg), t(this.lang, 'reset_expired')),
        ).catch(e => log('setup', 'edit_failed', { err: describeError(e) }))
      }
      log('setup', 'reset_expired')
    }
  }

  private doReset(reason: string): void {
    wipeSetup(this.h.cfg, this.h.store)
    this.h.saveSecret(null)
    this.h.onReset()
    log('setup', 'reset_done', { reason })
  }
}
// === GRACE END_BLOCK: broker_setup ============================================
