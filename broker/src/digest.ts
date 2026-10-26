// === GRACE START_BLOCK: broker_digest =========================================
// MODULE_CONTRACT:
//   IN:  open topics from the registry; <cwd>/STATUS.json of each, read on the
//        session machine; the usage file (through pin.ts); config.digest_at,
//        config.timezone, lang.
//   OUT: digestModule — once a day at digest_at (local to timezone) one
//        message into General: per topic ✅ done / ⏳ waiting / 🟥 blocked,
//        then the limits line; buildDigest() for `digest --now`.
//   INV: built by this script, no model in the loop: STATUS.json is the only
//        thing a topic contributes, and only as strict lists of short strings —
//        free text from one topic must not become instructions read in another.
//   INV: a topic whose STATUS.json is missing or broken is listed as
//        "no status", never skipped (empty ≠ nothing to report).
//   INV: at most one scheduled digest per local day, across restarts (the day
//        is kept in kv); a start after digest_at sends today's if it is still
//        missing.

import type { Config } from './config.ts'
import type { BrokerContext, BrokerModule } from './context.ts'
import type { Store, TopicRow } from './store.ts'
import { formatClock, limitsShort, loadUsage, localNow } from './pin.ts'
import { initRunner, readSessionFile } from './runner.ts'
import { t } from './strings.ts'
import { describeError } from './telegram.ts'

const CHECK_MS = 60_000
const FIRST_CHECK_MS = 10_000
const RETRY_MS = 5 * 60_000
const MAX_ITEM_CHARS = 200
const MAX_ITEMS_SHOWN = 20
const KV_LAST_DAY = 'digest_last_day'
const DIGEST_AT = /^([01]?\d|2[0-3]):([0-5]\d)$/

export type TopicStatus = { done: string[]; waiting: string[]; blocked: string[] }

function strictList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && Array.from(x).length <= MAX_ITEM_CHARS)
    // A line break inside an item could fake another topic's line.
    .map(x => x.replace(/\s+/g, ' ').trim())
    .filter(x => x.length > 0)
}

/** STATUS.json text → its three lists, or null when it is not a JSON object.
 *  Extra fields, non-strings and strings over 200 chars are dropped. */
export function parseStatus(raw: string | null): TopicStatus | null {
  if (raw === null) return null
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  return { done: strictList(o.done), waiting: strictList(o.waiting), blocked: strictList(o.blocked) }
}

function statusPath(cwd: string): string {
  return cwd.replace(/\/+$/, '') + '/STATUS.json'
}

function topicBlock(cfg: Config, row: TopicRow, st: TopicStatus | null): string[] {
  const L = cfg.lang
  const title = (row.title ?? row.name).replace(/\s+/g, ' ')
  if (!st) return [`${title} — ${t(L, 'digest_no_status')}`]
  const out = [`${title} — ✅ ${st.done.length} · ⏳ ${st.waiting.length} · 🟥 ${st.blocked.length}`]
  const list = (items: string[], fmt: (s: string) => string) => {
    for (const s of items.slice(0, MAX_ITEMS_SHOWN)) out.push(`  ${fmt(s)}`)
    if (items.length > MAX_ITEMS_SHOWN) out.push(`  ${t(L, 'digest_more', { n: items.length - MAX_ITEMS_SHOWN })}`)
  }
  list(st.done, s => `✅ ${s}`)
  list(st.waiting, s => `⏳ ${t(L, 'digest_waiting', { item: s })}`)
  list(st.blocked, s => `🟥 ${s}`)
  return out
}

/**
 * The digest text. General is left out: the orchestrator does no topic work
 * of its own, and a daily "General — no status" line would be noise.
 */
export async function buildDigest(cfg: Config, store: Store, now: Date, log?: BrokerContext['log']): Promise<string> {
  const L = cfg.lang
  const out = [t(L, 'digest_title', { at: formatClock(cfg, now, { label: true }) })]
  const topics = store.topics().filter(r => r.state === 'open' && r.name !== 'general')
  if (!topics.length) out.push(t(L, 'digest_no_topics'))
  for (const row of topics) {
    const raw = row.cwd ? await readSessionFile(statusPath(row.cwd)) : null
    const st = parseStatus(raw)
    log?.('digest_topic', { topic: row.name, status: st ? 'ok' : raw === null ? 'missing' : 'invalid' })
    out.push(...topicBlock(cfg, row, st))
  }
  out.push(limitsShort(cfg, await loadUsage(cfg), now))
  return out.join('\n')
}

/** "HH:MM" → minutes after midnight; a bad value falls back to 10:00. */
function digestMinutes(at: string): number {
  const m = DIGEST_AT.exec(at.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : 10 * 60
}

let busy = false
let retryAt = 0

async function check(ctx: BrokerContext): Promise<void> {
  if (busy || !ctx.isLocked() || Date.now() < retryAt) return
  const now = new Date()
  const { day, minutes } = localNow(ctx.config, now)
  if (minutes < digestMinutes(ctx.config.digest_at)) return
  busy = true
  try {
    if (ctx.store.get(KV_LAST_DAY) === day) return
    const text = await buildDigest(ctx.config, ctx.store, now, ctx.log)
    const ids = await ctx.tg.send('general', text)
    ctx.store.set(KV_LAST_DAY, day)
    ctx.log('digest_sent', { day, messages: ids.length, len: text.length })
  } catch (e) {
    // Retry later the same day; a failure after some chunks went out may
    // repeat them — accepted over losing the day's digest.
    retryAt = Date.now() + RETRY_MS
    ctx.log('digest_failed', { day, err: describeError(e) })
  } finally {
    busy = false
  }
}

export const digestModule: BrokerModule = {
  name: 'digest',
  start(ctx) {
    initRunner(ctx.config)
    if (!DIGEST_AT.test(ctx.config.digest_at.trim())) {
      ctx.log('digest_at_invalid', { len: ctx.config.digest_at.length, fallback: '10:00' })
    }
    setTimeout(() => void check(ctx), FIRST_CHECK_MS)
    setInterval(() => void check(ctx), CHECK_MS)
  },
}
// === GRACE END_BLOCK: broker_digest ===========================================
