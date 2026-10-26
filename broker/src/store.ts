// === GRACE START_BLOCK: broker_store ==========================================
// MODULE_CONTRACT:
//   IN:  <state_dir>/state.db (bun:sqlite, WAL, file 0600).
//   OUT: typed access to four tables:
//        updates(update_id PK, seq, topic, payload, delivered, created_at)
//          — durable per-topic event queue; seq is insertion order;
//        topics(name PK, chat_id, thread_id UNIQUE NULL, title, cwd,
//          session_id, key UNIQUE, state open|closed) — "general" has
//          thread_id NULL;
//        msg_topic(message_id PK, topic) — which topic a message belongs to;
//        kv(key PK, value) — offsets, setup state, small flags.
//   INV: an inbound event and the poll offset that covers it are committed in
//        one transaction, so after a crash Telegram either redelivers the
//        update (PK dedups it) or we already have it — never lost, never twice.
//   INV: message ids from the owner's private chat are stored NEGATED: Telegram
//        numbers messages per chat, and a DM id would otherwise collide with a
//        group message of the same number and steer a reaction or an edit at
//        the wrong message.

import { Database } from 'bun:sqlite'
import { chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { InboundEvent } from '../../plugin/protocol.ts'
import { log } from './context.ts'

export type TopicState = 'open' | 'closed'

export type TopicRow = {
  name: string
  chat_id: number
  thread_id: number | null
  title: string | null
  cwd: string | null
  session_id: string | null
  key: string
  state: TopicState
}

/** Stored event = protocol event without the wire tag. */
export type StoredEvent = Omit<InboundEvent, 't'>

export const QUEUE_MAX_EVENTS = 100
export const QUEUE_MAX_BYTES = 50 * 1024 * 1024
export const QUEUE_MAX_AGE_MS = 7 * 24 * 3600 * 1000

export class Store {
  readonly db: Database
  readonly path: string

  constructor(stateDir: string) {
    this.path = join(stateDir, 'state.db')
    const fresh = !existsSync(this.path)
    this.db = new Database(this.path, { create: true })
    if (fresh) chmodSync(this.path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS updates (
        update_id  INTEGER PRIMARY KEY,
        seq        INTEGER NOT NULL,
        topic      TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        delivered  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS updates_by_topic ON updates (topic, delivered, seq);
      CREATE TABLE IF NOT EXISTS topics (
        name       TEXT PRIMARY KEY,
        chat_id    INTEGER NOT NULL,
        thread_id  INTEGER UNIQUE,
        title      TEXT,
        cwd        TEXT,
        session_id TEXT,
        key        TEXT NOT NULL UNIQUE,
        state      TEXT NOT NULL CHECK (state IN ('open', 'closed'))
      );
      CREATE TABLE IF NOT EXISTS msg_topic (
        message_id INTEGER PRIMARY KEY,
        topic      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ---- kv ----------------------------------------------------------------------

  get(key: string): string | undefined {
    const r = this.db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get(key)
    return r?.value
  }

  set(key: string, value: string | number): void {
    this.db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }

  del(...keys: string[]): void {
    const q = this.db.query('DELETE FROM kv WHERE key = ?')
    for (const k of keys) q.run(k)
  }

  /** Offsets are per bot: a new bot's update ids start low, and an old bot's
   *  high offset would make Telegram treat all of them as already confirmed. */
  getOffset(botId: string): number | undefined {
    const v = this.get(`offset:${botId}`)
    return v === undefined ? undefined : Number(v)
  }

  setOffset(botId: string, offset: number): void {
    this.set(`offset:${botId}`, offset)
  }

  // ---- events ------------------------------------------------------------------

  /**
   * Commit one inbound event together with the offset that covers it, and
   * remember which topic the owner's message belongs to. Returns false when
   * the update was already stored (Telegram redelivered it after a crash).
   */
  ingest(botId: string, ev: StoredEvent): boolean {
    let inserted = false
    this.db.transaction(() => {
      inserted = this.insertEvent(ev)
      this.db.query('INSERT OR IGNORE INTO msg_topic (message_id, topic) VALUES (?, ?)').run(ev.message_id, ev.topic)
      this.setOffset(botId, ev.update_id + 1)
    })()
    if (inserted) this.prune(ev.topic)
    return inserted
  }

  /** Local event (forward, wake-up) — no Telegram update behind it, so it gets
   *  a negative update_id that can never collide with Telegram's positive ids. */
  enqueueLocal(ev: Omit<StoredEvent, 'update_id'>): StoredEvent {
    let full!: StoredEvent
    this.db.transaction(() => {
      const next = Number(this.get('local_update_id') ?? '0') - 1
      this.set('local_update_id', next)
      full = { ...ev, update_id: next } as StoredEvent
      this.insertEvent(full)
    })()
    this.prune(ev.topic)
    return full
  }

  private insertEvent(ev: StoredEvent): boolean {
    const r = this.db.query(
      `INSERT OR IGNORE INTO updates (update_id, seq, topic, payload, delivered, created_at)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM updates), ?, ?, 0, ?)`,
    ).run(ev.update_id, ev.topic, JSON.stringify(ev), Date.now())
    return r.changes > 0
  }

  undelivered(topic: string): StoredEvent[] {
    return this.db.query<{ payload: string }, [string]>(
      'SELECT payload FROM updates WHERE topic = ? AND delivered = 0 ORDER BY seq',
    ).all(topic).map(r => JSON.parse(r.payload) as StoredEvent)
  }

  /** Marks delivered only if the update belongs to this topic. */
  markDelivered(topic: string, updateId: number): boolean {
    return this.db.query('UPDATE updates SET delivered = 1 WHERE update_id = ? AND topic = ? AND delivered = 0')
      .run(updateId, topic).changes > 0
  }

  /** An owner event in a topic by its message id (for modules, e.g. forward). */
  findEvent(topic: string, messageId: number): StoredEvent | undefined {
    const rows = this.db.query<{ payload: string }, [string]>(
      'SELECT payload FROM updates WHERE topic = ? ORDER BY seq DESC',
    ).all(topic)
    for (const r of rows) {
      const ev = JSON.parse(r.payload) as StoredEvent
      if (ev.message_id === messageId) return ev
    }
    return undefined
  }

  countUndelivered(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM updates WHERE delivered = 0').get()?.n ?? 0
  }

  /**
   * Keep each topic's queue within 7 days, 100 events and 50 MB. Delivered
   * events go first; an undelivered one is only dropped when the queue is all
   * undelivered, and that loss is logged — a session that has been down for a
   * week should not keep the owner's whole backlog forever.
   */
  prune(topic?: string): void {
    const cutoff = Date.now() - QUEUE_MAX_AGE_MS
    const old = this.db.query<{ update_id: number; topic: string; delivered: number }, [number]>(
      'SELECT update_id, topic, delivered FROM updates WHERE created_at < ?',
    ).all(cutoff)
    for (const r of old) {
      if (!r.delivered) log('store', 'event_dropped', { reason: 'age', topic: r.topic, update_id: r.update_id })
    }
    if (old.length) this.db.query('DELETE FROM updates WHERE created_at < ?').run(cutoff)

    const topics = topic
      ? [topic]
      : this.db.query<{ topic: string }, []>('SELECT DISTINCT topic FROM updates').all().map(r => r.topic)
    for (const tp of topics) {
      for (;;) {
        const s = this.db.query<{ n: number; bytes: number | null }, [string]>(
          'SELECT COUNT(*) AS n, SUM(LENGTH(CAST(payload AS BLOB))) AS bytes FROM updates WHERE topic = ?',
        ).get(tp)
        if (!s || (s.n <= QUEUE_MAX_EVENTS && (s.bytes ?? 0) <= QUEUE_MAX_BYTES)) break
        const victim = this.db.query<{ update_id: number; delivered: number }, [string]>(
          'SELECT update_id, delivered FROM updates WHERE topic = ? ORDER BY delivered DESC, seq ASC LIMIT 1',
        ).get(tp)
        if (!victim) break
        if (!victim.delivered) log('store', 'event_dropped', { reason: 'queue_full', topic: tp, update_id: victim.update_id })
        this.db.query('DELETE FROM updates WHERE update_id = ?').run(victim.update_id)
      }
    }
  }

  // ---- message → topic ---------------------------------------------------------

  rememberMessage(messageId: number, topic: string): void {
    this.db.query('INSERT OR REPLACE INTO msg_topic (message_id, topic) VALUES (?, ?)').run(messageId, topic)
  }

  topicOfMessage(messageId: number): string | undefined {
    return this.db.query<{ topic: string }, [number]>('SELECT topic FROM msg_topic WHERE message_id = ?').get(messageId)?.topic
  }

  // ---- topics ------------------------------------------------------------------

  /** Creates (or re-creates after a reset) a topic with a fresh random key. */
  createTopic(t: { name: string; chat_id: number; thread_id: number | null; title?: string; cwd?: string }): TopicRow {
    const row: TopicRow = {
      name: t.name,
      chat_id: t.chat_id,
      thread_id: t.thread_id,
      title: t.title ?? null,
      cwd: t.cwd ?? null,
      session_id: null,
      key: randomBytes(24).toString('base64url'),
      state: 'open',
    }
    this.db.query(
      `INSERT INTO topics (name, chat_id, thread_id, title, cwd, session_id, key, state)
       VALUES ($name, $chat_id, $thread_id, $title, $cwd, $session_id, $key, $state)`,
    ).run({
      $name: row.name, $chat_id: row.chat_id, $thread_id: row.thread_id, $title: row.title,
      $cwd: row.cwd, $session_id: row.session_id, $key: row.key, $state: row.state,
    })
    return row
  }

  topic(name: string): TopicRow | undefined {
    return this.db.query<TopicRow, [string]>('SELECT * FROM topics WHERE name = ?').get(name) ?? undefined
  }

  topicByKey(key: string): TopicRow | undefined {
    return this.db.query<TopicRow, [string]>('SELECT * FROM topics WHERE key = ?').get(key) ?? undefined
  }

  topicByThread(threadId: number): TopicRow | undefined {
    return this.db.query<TopicRow, [number]>('SELECT * FROM topics WHERE thread_id = ?').get(threadId) ?? undefined
  }

  topics(): TopicRow[] {
    return this.db.query<TopicRow, []>('SELECT * FROM topics ORDER BY name').all()
  }

  setTopicState(name: string, state: TopicState): void {
    this.db.query('UPDATE topics SET state = ? WHERE name = ?').run(state, name)
  }

  updateTopic(name: string, f: Partial<Pick<TopicRow, 'title' | 'cwd' | 'session_id'>>): void {
    for (const [col, val] of Object.entries(f)) {
      if (!['title', 'cwd', 'session_id'].includes(col)) continue
      this.db.query(`UPDATE topics SET ${col} = ? WHERE name = ?`).run(val ?? null, name)
    }
  }

  /** Topic closed: its undelivered events go, so a reopen (maybe days later)
   *  does not hand the session stale orders. Returns how many were dropped. */
  dropUndelivered(topic: string): number {
    return this.db.query('DELETE FROM updates WHERE topic = ? AND delivered = 0').run(topic).changes
  }

  /** The topic is gone in Telegram: drop its row, queue, message map and the
   *  modules' per-topic kv (keys "topic:<name>:…"). Folders are not ours to
   *  delete and live elsewhere anyway. */
  deleteTopic(name: string): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM topics WHERE name = ?').run(name)
      this.db.query('DELETE FROM updates WHERE topic = ?').run(name)
      this.db.query('DELETE FROM msg_topic WHERE topic = ?').run(name)
      // substr, not LIKE: a topic name must never act as a pattern.
      const p = `topic:${name}:`
      this.db.query('DELETE FROM kv WHERE substr(key, 1, ?) = ?').run(p.length, p)
    })()
  }

  /** Setup reset: forget everything except poll offsets (they belong to the
   *  bot, not to the setup, and dropping one would replay old updates) and the
   *  local id counter (a shim that saw -1 before the reset must not dedup a
   *  new -1 away). */
  wipe(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM updates; DELETE FROM topics; DELETE FROM msg_topic;')
      this.db.exec("DELETE FROM kv WHERE key NOT LIKE 'offset:%' AND key <> 'local_update_id'")
    })()
  }
}
// === GRACE END_BLOCK: broker_store ============================================
