// === GRACE START_BLOCK: broker_topics =========================================
// MODULE_CONTRACT:
//   IN:  create_topic / forward calls from the General session; forum service
//        messages (topic edited / closed / reopened) from the poller; a probe
//        every 10 min for topics deleted in Telegram.
//   OUT: create_topic — Telegram topic + registry row (fresh key) + folder +
//        session (sessions.ensure) → {name, thread_id, cwd}; forward — the
//        owner's message from General reposted in a topic as
//        "📨 from the owner via General: …" and queued for that topic's
//        session with forwarded_from_general → {message_id}; registry kept in
//        step with Telegram (title, open/closed, deleted).
//   INV: only the owner's words travel between topics: forward accepts only an
//        event recorded in General from owner_id, never a forwarded one and
//        never text supplied by the session.
//   INV: a partial create is reported as such — every step after
//        createForumTopic says what was done and what was not, and the call
//        fails; the topic stays in Telegram and in the registry, and the
//        sessions watchdog keeps retrying the folder and the session.
//   INV: closing a topic unbinds its shim and stops restarts; deleting one
//        closes its own terminals (proved by launch history), then drops it
//        from the registry; neither ever touches its folder.

import type { Update } from 'grammy/types'
import type { BrokerContext, BrokerModule, ConnInfo } from './context.ts'
import { initRunner } from './runner.ts'
import { cleanTitle, closeTopicTerminals, ensure } from './sessions.ts'
import { t } from './strings.ts'
import { describeError } from './telegram.ts'

export const topicTiming = {
  probeMs: 10 * 60_000,
  /** create_topic answers within the shim's 120 s call timeout */
  createEnsureMs: 80_000,
}

const NAME_RE = /^[a-z0-9-]{1,32}$/
// Telegram's wording for a topic that no longer exists (sendChatAction into it).
const THREAD_GONE_RE = /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i

let probeTimer: ReturnType<typeof setInterval> | null = null
let probing = false

function requireGeneral(conn: ConnInfo, tool: string): void {
  if (conn.mode !== 'topic' || conn.topic !== 'general') throw new Error(`${tool}: only the General session may call this`)
}

function partial(done: string[], failed: string, next: string): Error {
  return new Error(`create_topic finished only partly. Done: ${done.join('; ')}. Not done: ${failed}. ${next}`)
}

async function createTopic(a: Record<string, unknown>, conn: ConnInfo, ctx: BrokerContext) {
  requireGeneral(conn, 'create_topic')
  const name = a.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('create_topic: name must match [a-z0-9-]{1,32}')
  if (name === 'general') throw new Error('create_topic: "general" is reserved')
  if (ctx.store.topic(name)) throw new Error(`create_topic: topic ${name} already exists`)
  const title = cleanTitle(a.title) ?? name
  const owner = ctx.owner()
  if (!owner) throw new Error('create_topic: broker is not configured')

  const ft = await ctx.tg.call(api => api.createForumTopic(owner.chat_id, title), { message: true })
  const thread = ft.message_thread_id
  ctx.log('topic_created', { topic: name, thread_id: thread })
  const done = [`Telegram topic "${title}" created (thread ${thread})`]
  const later = 'The topic is kept; the watchdog retries the folder and the session every minute — check again later, do not create the topic again.'

  try {
    ctx.store.createTopic({ name, chat_id: owner.chat_id, thread_id: thread, title })
    ctx.store.set(`topic:${name}:created_at`, Date.now())
  } catch (e) {
    throw partial(done, `registering the topic (${describeError(e)})`, 'Messages in this topic are dropped until it is registered; ask the owner to delete it and create it again.')
  }
  done.push('registered with its own key')

  let timer: ReturnType<typeof setTimeout> | undefined
  const res = await Promise.race([
    ensure(name),
    new Promise<null>(r => { timer = setTimeout(() => r(null), topicTiming.createEnsureMs) }),
  ])
  clearTimeout(timer)
  if (res === null) throw partial(done, `session start did not finish within ${topicTiming.createEnsureMs / 1000} s`, later)
  if (res.prepare) {
    const s = Object.entries(res.prepare.steps).map(([k, v]) => `${k}: ${v}`).join(', ')
    if (res.prepare.ok) done.push(`folder ${res.prepare.cwd} prepared (${s})`)
    else throw partial(done, `folder ${res.prepare.cwd ?? ''} (${res.prepare.error}${s ? `; ${s}` : ''})`, later)
  }
  if (!res.launched && res.reason !== 'connected' && res.reason !== 'recent_launch') {
    throw partial(done, `session start (${res.reason}${res.error ? `: ${res.error}` : ''})`, later)
  }
  return { name, thread_id: thread, cwd: res.cwd ?? ctx.store.topic(name)?.cwd ?? '' }
}

async function forward(a: Record<string, unknown>, conn: ConnInfo, ctx: BrokerContext) {
  requireGeneral(conn, 'forward')
  const owner = ctx.owner()
  if (!owner) throw new Error('forward: broker is not configured')
  const topic = a.topic
  if (typeof topic !== 'string' || !topic) throw new Error('forward: topic must be a topic name')
  if (topic === 'general') throw new Error('forward: cannot forward into General itself')
  const row = ctx.store.topic(topic)
  if (!row) throw new Error(`forward: no topic ${topic}`)
  if (row.state !== 'open') throw new Error(`forward: topic ${topic} is closed`)
  const sid = typeof a.source_message_id === 'string' ? Number(a.source_message_id) : a.source_message_id
  if (typeof sid !== 'number' || !Number.isInteger(sid) || sid === 0) throw new Error('forward: source_message_id must be a message id')

  const ev = ctx.store.findEvent('general', sid)
  // Only the owner's own words: a session's text (or a relayed one) must not
  // become an order in another topic.
  if (!ev || ev.user_id !== String(owner.owner_id) || ev.forwarded_from_general) {
    ctx.log('forward_refused', { topic, source: sid, found: !!ev })
    throw new Error("forward: only the owner's own messages in General can be forwarded (by their message_id)")
  }

  const ids = await ctx.tg.send(topic, t(ctx.config.lang, 'forward_prefix', { text: ev.text }))
  const mid = ids[0]!
  ctx.enqueueEvent(topic, {
    message_id: mid,
    user: ev.user,
    user_id: ev.user_id,
    ts: new Date().toISOString(),
    text: ev.text,
    ...(ev.attachment ? { attachment: ev.attachment } : {}),
    forwarded_from_general: { message_id: sid },
  })
  ctx.log('forwarded', { topic, source: sid, message_id: mid, len: ev.text.length })
  return { message_id: mid }
}

function onUpdate(u: Update, ctx: BrokerContext): boolean {
  const m = u.message
  const owner = ctx.owner()
  if (!m || !owner || m.chat.id !== owner.chat_id || m.message_thread_id === undefined) return false
  if (!m.forum_topic_edited && !m.forum_topic_closed && !m.forum_topic_reopened) return false
  const row = ctx.store.topicByThread(m.message_thread_id)
  if (!row) {
    ctx.log('topic_event_unknown_thread', { update_id: u.update_id, thread_id: m.message_thread_id })
    return true
  }
  if (m.forum_topic_edited) {
    const title = cleanTitle(m.forum_topic_edited.name)
    if (title) {
      ctx.store.updateTopic(row.name, { title })
      ctx.log('topic_renamed', { topic: row.name })
    }
  } else if (m.forum_topic_closed) {
    ctx.store.setTopicState(row.name, 'closed')
    ctx.unbind(row.name, 'topic closed')
    const dropped = ctx.store.dropUndelivered(row.name)
    ctx.log('topic_closed', { topic: row.name, undelivered_dropped: dropped })
  } else if (m.forum_topic_reopened) {
    ctx.store.setTopicState(row.name, 'open')
    // Closing unbound the shim for good (it drops its key on "unbound"), so its
    // still-running Claude can never reconnect: the next ensure replaces our
    // own terminal (resuming the conversation) instead of waiting on it.
    ctx.store.set(`topic:${row.name}:force_relaunch`, 1)
    ctx.log('topic_reopened', { topic: row.name })
  }
  return true
}

/** Telegram does not tell bots about deleted topics: a chat action into a
 *  deleted thread fails with "message thread not found". */
export async function probeTopics(ctx: BrokerContext): Promise<void> {
  const owner = ctx.owner()
  if (probing || !owner) return
  probing = true
  try {
    for (const row of ctx.store.topics()) {
      if (row.state !== 'open' || row.thread_id === null) continue
      const thread = row.thread_id
      try {
        await ctx.tg.call(api => api.sendChatAction(owner.chat_id, 'typing', { message_thread_id: thread }))
      } catch (e) {
        const err = describeError(e)
        if (!THREAD_GONE_RE.test(err)) {
          ctx.log('probe_failed', { topic: row.name, err })
          continue
        }
        ctx.unbind(row.name, 'topic deleted')
        // Close its session first: deleteTopic wipes the launch history that
        // proves which terminals are ours, and a re-created topic of the same
        // name would otherwise get a second Claude in the same folder.
        try {
          await closeTopicTerminals(row.name)
        } catch (e) {
          ctx.log('topic_terminals_close_failed', { topic: row.name, err: describeError(e) })
        }
        ctx.store.deleteTopic(row.name)
        ctx.log('topic_deleted', { topic: row.name, thread_id: thread })
        await ctx.notifyGeneral(t(ctx.config.lang, 'topic_deleted', { name: row.name, cwd: row.cwd ?? '-' }))
      }
    }
  } finally {
    probing = false
  }
}

export const topicsModule: BrokerModule = {
  name: 'topics',
  start(ctx) {
    initRunner(ctx.config)
    if (probeTimer) clearInterval(probeTimer)
    probeTimer = setInterval(() => void probeTopics(ctx).catch(e => ctx.log('probe_tick_failed', { err: describeError(e) })), topicTiming.probeMs)
    probeTimer.unref?.()
  },
  onUpdate,
  tools: { create_topic: createTopic, forward },
}
// === GRACE END_BLOCK: broker_topics ===========================================
