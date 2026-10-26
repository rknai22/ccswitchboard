// === GRACE START_BLOCK: broker_pin ============================================
// MODULE_CONTRACT:
//   IN:  config.usage_file on the session machine (written by
//        usage/usage-poll.ts every 5 min), read through the session runner;
//        config.timezone and lang for the text.
//   OUT: pinModule — keeps ONE pinned "Claude limits" message in General up
//        to date (every 5 min and right after setup locks);
//        the shared limits rules for the digest: loadUsage, parseUsage,
//        renderPin, limitsShort, plus the clock helpers (formatClock,
//        localNow) both modules print times with.
//   INV: unknown is never shown as 0 %: a missing file, broken JSON, an
//        `error` in the file or a null window prints "no data" on that line.
//   INV: no error in here reaches the core — a failed tick is logged and the
//        next one tries again; the broker keeps running.
//   INV: the pinned message is sent through tg.call, not tg.send, so it is not
//        recorded for the General topic and the General session cannot edit
//        it into fake numbers.

import type { Config, Lang } from './config.ts'
import type { BrokerContext, BrokerModule } from './context.ts'
import { initRunner, readSessionFile } from './runner.ts'
import type { Store } from './store.ts'
import { t } from './strings.ts'
import { describeError } from './telegram.ts'

const TICK_MS = 5 * 60_000
const FIRST_TICK_MS = 5_000
const STALE_MS = 15 * 60_000
const KV_PIN = 'pin_message'
const DEFAULT_USAGE_FILE = '~/.local/state/ccswitchboard/usage.json'

// ---- clock --------------------------------------------------------------------

const tzOk = new Map<string, boolean>()

/** A timezone Intl accepts; a typo in config falls back to UTC, not a crash. */
export function safeTz(tz: string): string {
  if (!tzOk.has(tz)) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      tzOk.set(tz, true)
    } catch {
      tzOk.set(tz, false)
    }
  }
  return tzOk.get(tz) ? tz : 'UTC'
}

function tzLabel(tz: string, lang: Lang, d: Date): string {
  if (tz === 'Europe/Moscow') return lang === 'ru' ? 'МСК' : 'MSK'
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d)
  return p.find(x => x.type === 'timeZoneName')?.value ?? tz
}

/** Local calendar day (YYYY-MM-DD) and minutes since local midnight. */
export function localNow(cfg: Config, d: Date): { day: string; minutes: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(cfg.timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)
  const get = (k: string) => p.find(x => x.type === k)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

/** "18:40", "пт 07:00", "18:40 МСК" — in config.timezone. */
export function formatClock(cfg: Config, d: Date, o: { weekday?: boolean; label?: boolean } = {}): string {
  const tz = safeTz(cfg.timezone)
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  // ICU builds differ on "Пт" vs "пт"; Russian writes weekdays lowercase.
  const wd = o.weekday
    ? (cfg.lang === 'ru'
      ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short' }).format(d).replace(/\.$/, '').toLowerCase()
      : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)) + ' '
    : ''
  return `${wd}${hm}${o.label ? ' ' + tzLabel(tz, cfg.lang, d) : ''}`
}

// ---- usage file ---------------------------------------------------------------

export type UsageWindow = { pct: number; resets_at: Date | null }
export type Usage = {
  /** When usage-poll ran; null when the file is missing or broken. */
  ts: Date | null
  five_hour: UsageWindow | null
  week: UsageWindow | null
  error?: string
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseWindow(v: unknown): UsageWindow | null {
  if (!v || typeof v !== 'object') return null
  const w = v as Record<string, unknown>
  if (typeof w.pct !== 'number' || !Number.isFinite(w.pct) || w.pct < 0) return null
  return { pct: w.pct, resets_at: parseDate(w.resets_at) }
}

/** usage.json text → Usage. Never throws; an `error` in the file voids the
 *  numbers next to it (usage-poll writes null there anyway). */
export function parseUsage(raw: string | null): Usage {
  if (raw === null) return { ts: null, five_hour: null, week: null, error: 'no_file' }
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { ts: null, five_hour: null, week: null, error: 'bad_json' }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ts: null, five_hour: null, week: null, error: 'bad_json' }
  const o = j as Record<string, unknown>
  const ts = parseDate(o.ts)
  if (o.error !== undefined && o.error !== null) {
    return { ts, five_hour: null, week: null, error: typeof o.error === 'string' ? o.error.slice(0, 64) : 'error' }
  }
  return { ts, five_hour: parseWindow(o.five_hour), week: parseWindow(o.week) }
}

export async function loadUsage(cfg: Config): Promise<Usage> {
  return parseUsage(await readSessionFile(cfg.usage_file || DEFAULT_USAGE_FILE))
}

/** usage-poll's token comes from live sessions (Claude refreshes it); an
 *  expired one means nothing has run for a while — the same story as an old
 *  file. */
function isStale(u: Usage, now: Date): boolean {
  return u.error === 'token_expired' || (u.ts !== null && now.getTime() - u.ts.getTime() > STALE_MS)
}

function color(pct: number): string {
  return pct >= 90 ? '🟥' : pct >= 70 ? '🟨' : '🟩'
}

function pctText(lang: Lang, pct: number): string {
  return t(lang, 'limits_pct', { pct: Math.round(pct) })
}

function asOf(cfg: Config, ts: Date, now: Date): string {
  const sameDay = localNow(cfg, ts).day === localNow(cfg, now).day
  return formatClock(cfg, ts, { weekday: !sameDay, label: true })
}

/** The pinned message text. */
export function renderPin(cfg: Config, u: Usage, now: Date): string {
  const L = cfg.lang
  const line = (key: 'limits_five_hour' | 'limits_week', w: UsageWindow | null, weekly: boolean) => {
    if (!w) return `${t(L, key)}: ${t(L, 'limits_no_data')}`
    const reset = w.resets_at
      ? ` · ${t(L, 'limits_reset', { at: formatClock(cfg, w.resets_at, weekly ? { weekday: true, label: true } : {}) })}`
      : ''
    return `${t(L, key)}: ${color(w.pct)} ${pctText(L, w.pct)}${reset}`
  }
  const out = [t(L, 'limits_title'), line('limits_five_hour', u.five_hour, false), line('limits_week', u.week, true)]
  if (u.ts) out.push(t(L, 'limits_as_of', { at: asOf(cfg, u.ts, now) }))
  if (isStale(u, now)) out.push(t(L, 'limits_stale'))
  return out.join('\n')
}

/** One line for the digest: "Limits: 5 h 12% · week 75%". */
export function limitsShort(cfg: Config, u: Usage, now: Date): string {
  const L = cfg.lang
  const p = (w: UsageWindow | null) => (w ? pctText(L, w.pct) : t(L, 'limits_no_data'))
  let s = t(L, 'limits_short', { five: p(u.five_hour), week: p(u.week) })
  if (u.ts && isStale(u, now)) s += ` ${t(L, 'limits_short_as_of', { at: asOf(cfg, u.ts, now) })}`
  return s
}

// ---- the pinned message -------------------------------------------------------

type SavedPin = { chat_id: number; message_id: number; pinned: boolean }

function readSaved(store: Store): SavedPin | null {
  try {
    const v = JSON.parse(store.get(KV_PIN) ?? 'null') as SavedPin | null
    return v && typeof v.chat_id === 'number' && typeof v.message_id === 'number' ? v : null
  } catch {
    return null
  }
}

const GONE = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i
const SAME = /message is not modified/i

async function ensurePinned(ctx: BrokerContext, p: SavedPin): Promise<void> {
  try {
    await ctx.tg.call(api => api.pinChatMessage(p.chat_id, p.message_id, { disable_notification: true }))
    ctx.store.set(KV_PIN, JSON.stringify({ ...p, pinned: true }))
    ctx.log('pin_pinned', { message_id: p.message_id })
  } catch (e) {
    // Most likely the bot lacks "Pin messages": keep the message (no new one
    // every 5 min) and retry pinning on the next tick.
    ctx.log('pin_pin_failed', { message_id: p.message_id, err: describeError(e) })
  }
}

async function upsert(ctx: BrokerContext, chat: number, text: string): Promise<void> {
  const saved = readSaved(ctx.store)
  if (saved && saved.chat_id === chat) {
    let gone = false
    try {
      await ctx.tg.call(api => api.editMessageText(chat, saved.message_id, text), { message: true })
      ctx.log('pin_edited', { message_id: saved.message_id, len: text.length })
    } catch (e) {
      const d = describeError(e)
      if (SAME.test(d)) ctx.log('pin_unchanged', { message_id: saved.message_id })
      else if (GONE.test(d)) {
        ctx.log('pin_gone', { message_id: saved.message_id, err: d })
        gone = true
      } else throw e
    }
    if (!gone) {
      if (!saved.pinned) await ensurePinned(ctx, saved)
      return
    }
  }
  const m = await ctx.tg.call(api => api.sendMessage(chat, text, { disable_notification: true }), { message: true })
  const p: SavedPin = { chat_id: chat, message_id: m.message_id, pinned: false }
  ctx.store.set(KV_PIN, JSON.stringify(p))
  ctx.log('pin_created', { message_id: m.message_id, len: text.length })
  await ensurePinned(ctx, p)
}

let busy = false

async function tick(ctx: BrokerContext, why: string): Promise<void> {
  if (busy || !ctx.isLocked()) return
  busy = true
  try {
    const owner = ctx.owner()
    if (!owner) return
    const now = new Date()
    const u = await loadUsage(ctx.config)
    ctx.log('pin_tick', { why, error: u.error ?? null, stale: isStale(u, now) })
    await upsert(ctx, owner.chat_id, renderPin(ctx.config, u, now))
  } catch (e) {
    ctx.log('pin_failed', { why, err: describeError(e) })
  } finally {
    busy = false
  }
}

export const pinModule: BrokerModule = {
  name: 'pin',
  start(ctx) {
    initRunner(ctx.config)
    // The core sets the bot token only after modules start: give it a moment.
    setTimeout(() => void tick(ctx, 'start'), FIRST_TICK_MS)
    setInterval(() => void tick(ctx, 'timer'), TICK_MS)
  },
  async onLocked(ctx) {
    await tick(ctx, 'locked')
  },
}
// === GRACE END_BLOCK: broker_pin ==============================================
