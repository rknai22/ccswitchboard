// === GRACE START_BLOCK: broker_tasks ==========================================
// MODULE_CONTRACT:
//   IN:  propose_task (General), report / tasks / ask_owner / tell_topic (any
//        bound topic); the owner's presses on ccst:* (task) and ccsq:*
//        (question) buttons; /tasks through the commands module.
//   OUT: the task registry (tables tasks, task_events, questions); task specs
//        delivered to topics after the owner's ✅; done / blocked /
//        waiting_owner reports announced in General by the broker itself;
//        owner answers to ask_owner questions; tell_topic messages.
//   INV: only the owner's button turns a session-written text into an order:
//        an approved spec is delivered as the owner's words (task_id +
//        forwarded_from_general_message_id); a tell_topic message is delivered
//        with from_topic and never as the owner's.
//   INV: a proposal is immutable; its buttons work once, only for the owner,
//        and only while it is still proposed and younger than PROPOSAL_TTL_MS.
//   INV: a topic reports only on its own tasks.
//   INV: texts from sessions shown to the owner are capped; they reach other
//        sessions only through the tasks tool (as data) or tell_topic.

import type { Update } from 'grammy/types'
import type { TaskState, TaskView } from '../../plugin/protocol.ts'
import type { BrokerContext, BrokerModule, ConnInfo } from './context.ts'
import { t } from './strings.ts'

export const taskLimits = {
  proposalTtlMs: 7 * 24 * 3600_000,
  titleChars: 200,
  specChars: 12_000,
  summaryChars: 1000,
  questionChars: 1000,
  optionChars: 40,
  maxOptions: 6,
  tellChars: 2000,
  tellPerHour: 10,
}

const REPORTABLE: TaskState[] = ['in_progress', 'waiting_owner', 'blocked', 'done', 'cancelled']
const OPEN: TaskState[] = ['proposed', 'assigned', 'in_progress', 'waiting_owner', 'blocked']
const ICON: Record<TaskState, string> = {
  proposed: '📝', assigned: '📋', in_progress: '⚙️', waiting_owner: '⏳', blocked: '🟥', done: '✅', cancelled: '✖️',
}

type TaskRow = {
  id: number; topic: string; title: string; spec: string | null; state: TaskState; source: 'general' | 'topic'
  created_at: number; updated_at: number; last_report_at: number | null; summary: string | null; next_step: string | null
  proposal_msg: number | null
}

let ctxRef: BrokerContext | null = null
function ctx(): BrokerContext {
  if (!ctxRef) throw new Error('tasks module not started')
  return ctxRef
}

export function initTables(c: BrokerContext): void {
  c.store.db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      topic          TEXT NOT NULL,
      title          TEXT NOT NULL,
      spec           TEXT,
      state          TEXT NOT NULL,
      source         TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_report_at INTEGER,
      summary        TEXT,
      next_step      TEXT,
      proposal_msg   INTEGER
    );
    CREATE INDEX IF NOT EXISTS tasks_by_topic ON tasks (topic, state);
    CREATE TABLE IF NOT EXISTS task_events (
      task_id INTEGER NOT NULL,
      at      INTEGER NOT NULL,
      who     TEXT NOT NULL,
      kind    TEXT NOT NULL,
      text    TEXT
    );
    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      topic      TEXT NOT NULL,
      question   TEXT NOT NULL,
      options    TEXT NOT NULL,
      message_id INTEGER,
      answer     TEXT,
      created_at INTEGER NOT NULL
    );
  `)
}

const cap = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '')

function task(id: number): TaskRow | undefined {
  return ctx().store.db.query<TaskRow, [number]>('SELECT * FROM tasks WHERE id = ?').get(id) ?? undefined
}

function event(id: number, who: string, kind: string, text?: string): void {
  ctx().store.db.query('INSERT INTO task_events (task_id, at, who, kind, text) VALUES (?, ?, ?, ?, ?)')
    .run(id, Date.now(), who, kind, text ?? null)
}

function insertTask(f: { topic: string; title: string; spec?: string; state: TaskState; source: 'general' | 'topic' }): number {
  const now = Date.now()
  const r = ctx().store.db.query(
    `INSERT INTO tasks (topic, title, spec, state, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.topic, f.title, f.spec ?? null, f.state, f.source, now, now)
  return Number(r.lastInsertRowid)
}

function setState(id: number, state: TaskState, extra: Partial<Pick<TaskRow, 'summary' | 'next_step' | 'last_report_at' | 'proposal_msg'>> = {}): void {
  const cols = ['state = ?', 'updated_at = ?']
  const vals: (string | number | null)[] = [state, Date.now()]
  for (const [k, v] of Object.entries(extra)) {
    cols.push(`${k} = ?`)
    vals.push(v ?? null)
  }
  ctx().store.db.query(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id)
}

function requireTopic(conn: ConnInfo, tool: string): string {
  if (conn.mode !== 'topic' || !conn.topic) throw new Error(`${tool}: this connection is not bound to a topic`)
  return conn.topic
}

export function view(r: TaskRow, c: BrokerContext = ctx()): TaskView {
  const ref = r.last_report_at ?? r.created_at
  return {
    id: r.id, topic: r.topic, title: r.title, state: r.state, source: r.source,
    summary: r.summary, next_step: r.next_step,
    report_age_min: Math.max(0, Math.round((Date.now() - ref) / 60_000)),
    session_connected: c.isConnected(r.topic),
    session_busy: c.isBusy(r.topic),
  }
}

export function listTasks(topic?: string, openOnly = true): TaskRow[] {
  const where: string[] = []
  const vals: string[] = []
  if (topic) { where.push('topic = ?'); vals.push(topic) }
  if (openOnly) where.push(`state IN (${OPEN.map(s => `'${s}'`).join(',')})`)
  return ctx().store.db.query<TaskRow, string[]>(
    `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY topic, id`,
  ).all(...vals)
}

/** Owner-facing list for /tasks: one line per task, report age shown. */
export function tasksText(c: BrokerContext, topic: string | null): string {
  const L = c.config.lang
  const rows = listTasks(topic ?? undefined, true)
  if (!rows.length) return t(L, 'tasks_none')
  return rows.map(r => {
    const v = view(r, c)
    const where = topic ? '' : `${r.topic} `
    return `${ICON[r.state]} ${where}#${r.id} ${r.title} · ${t(L, 'tasks_age', { min: v.report_age_min })}`
  }).join('\n')
}

// ---- tools ---------------------------------------------------------------------------

async function proposeTask(a: Record<string, unknown>, conn: ConnInfo, c: BrokerContext) {
  if (conn.mode !== 'topic' || conn.topic !== 'general') throw new Error('propose_task: only the General session may call this')
  const topic = cap(a.topic, 32)
  const row = c.store.topic(topic)
  if (!row || topic === 'general') throw new Error(`propose_task: no topic ${topic || '(empty)'}`)
  if (row.state !== 'open') throw new Error(`propose_task: topic ${topic} is closed`)
  const title = cap(a.title, taskLimits.titleChars)
  const spec = cap(a.spec, taskLimits.specChars)
  if (!title || !spec) throw new Error('propose_task: title and spec are required')
  const id = insertTask({ topic, title, spec, state: 'proposed', source: 'general' })
  event(id, 'general', 'proposed')
  const L = c.config.lang
  const markup = {
    inline_keyboard: [[
      { text: t(L, 'task_send_button', { topic }), callback_data: `ccst:${id}:ok` },
      { text: t(L, 'task_cancel_button'), callback_data: `ccst:${id}:no` },
    ]],
  }
  const ids = await c.tg.send('general', `${t(L, 'task_proposed', { id, topic, title })}\n\n${spec}`, { format: 'markdown', reply_markup: markup })
  const mid = ids[ids.length - 1]!
  setState(id, 'proposed', { proposal_msg: mid })
  c.log('task_proposed', { id, topic, len: spec.length })
  return { task_id: id, message_id: mid }
}

async function report(a: Record<string, unknown>, conn: ConnInfo, c: BrokerContext) {
  const topic = requireTopic(conn, 'report')
  const state = a.state as TaskState
  if (!REPORTABLE.includes(state)) throw new Error(`report: state must be one of ${REPORTABLE.join(', ')}`)
  const summary = cap(a.summary, taskLimits.summaryChars)
  if (!summary) throw new Error('report: summary is required')
  const next = cap(a.next_step, taskLimits.summaryChars) || null
  let id: number
  if (a.task_id === undefined || a.task_id === null || a.task_id === '') {
    const title = cap(a.title, taskLimits.titleChars)
    if (!title) throw new Error('report: give task_id, or a title to register a new task of this topic')
    id = insertTask({ topic, title, state, source: 'topic' })
    event(id, topic, 'created')
  } else {
    id = Number(a.task_id)
    const r = Number.isInteger(id) ? task(id) : undefined
    if (!r) throw new Error(`report: no task #${a.task_id}`)
    if (r.topic !== topic) throw new Error(`report: task #${id} belongs to topic ${r.topic}`)
    if (r.state === 'proposed') throw new Error(`report: task #${id} is not approved yet`)
  }
  setState(id, state, { summary, next_step: next, last_report_at: Date.now() })
  event(id, topic, state, summary)
  const r = task(id)!
  c.log('task_report', { id, topic, state })
  if (state === 'done' || state === 'blocked' || state === 'waiting_owner') {
    await c.tg.send('general', t(c.config.lang, `task_${state}`, { icon: ICON[state], topic, id, title: r.title, summary }), { format: 'text' })
      .catch(e => c.log('task_notice_failed', { id, err: e instanceof Error ? e.message : String(e) }))
  }
  return { task_id: id, state }
}

async function tasksTool(a: Record<string, unknown>, conn: ConnInfo, c: BrokerContext) {
  const topic = requireTopic(conn, 'tasks')
  const want = cap(a.topic, 32) || undefined
  if (topic !== 'general' && want && want !== topic) throw new Error('tasks: a topic sees only its own tasks')
  const scope = topic === 'general' ? want : topic
  return { tasks: listTasks(scope, a.open_only !== false).map(r => view(r, c)) }
}

async function askOwner(a: Record<string, unknown>, conn: ConnInfo, c: BrokerContext) {
  const topic = requireTopic(conn, 'ask_owner')
  const question = cap(a.question, taskLimits.questionChars)
  if (!question) throw new Error('ask_owner: question is required')
  const L = c.config.lang
  const raw = Array.isArray(a.options) && a.options.length ? a.options : [t(L, 'ask_yes'), t(L, 'ask_no')]
  const options = raw.map(o => cap(o, taskLimits.optionChars)).filter(Boolean).slice(0, taskLimits.maxOptions)
  if (!options.length) throw new Error('ask_owner: options must be non-empty strings')
  const r = c.store.db.query('INSERT INTO questions (topic, question, options, created_at) VALUES (?, ?, ?, ?)')
    .run(topic, question, JSON.stringify(options), Date.now())
  const qid = Number(r.lastInsertRowid)
  const markup = { inline_keyboard: options.map((o, i) => [{ text: o, callback_data: `ccsq:${qid}:${i}` }]) }
  const ids = await c.tg.send(topic, `❓ ${question}`, { format: 'markdown', reply_markup: markup })
  const mid = ids[ids.length - 1]!
  c.store.db.query('UPDATE questions SET message_id = ? WHERE id = ?').run(mid, qid)
  c.log('question_asked', { topic, qid, options: options.length })
  return { question_id: qid, message_id: mid }
}

const tellLog = new Map<string, number[]>()

async function tellTopic(a: Record<string, unknown>, conn: ConnInfo, c: BrokerContext) {
  const from = requireTopic(conn, 'tell_topic')
  const to = cap(a.topic, 32)
  const text = cap(a.text, taskLimits.tellChars)
  if (!text) throw new Error('tell_topic: text is required')
  if (to === 'general') throw new Error('tell_topic: General is not a target — it reads tasks and reports itself')
  if (to === from) throw new Error('tell_topic: cannot write to your own topic')
  const row = c.store.topic(to)
  if (!row || row.state !== 'open') throw new Error(`tell_topic: no open topic ${to}`)
  const key = `${from}>${to}`
  const now = Date.now()
  const recent = (tellLog.get(key) ?? []).filter(x => now - x < 3600_000)
  if (recent.length >= taskLimits.tellPerHour) throw new Error(`tell_topic: limit of ${taskLimits.tellPerHour} messages per hour from ${from} to ${to} reached`)
  recent.push(now)
  tellLog.set(key, recent)
  const ids = await c.tg.send(to, `💬 ${t(c.config.lang, 'tell_from', { from })}\n${text}`, { format: 'text', silent: true })
  c.enqueueEvent(to, {
    message_id: ids[0]!, user: `topic:${from}`, user_id: '0', ts: new Date().toISOString(), text, from_topic: from,
  })
  c.log('tell_topic', { from, to, len: text.length })
  return { message_id: ids[0]! }
}

// ---- buttons ---------------------------------------------------------------------------

async function onTaskButton(cq: NonNullable<Update['callback_query']>, c: BrokerContext): Promise<void> {
  const L = c.config.lang
  const answer = (key?: 'callback_done' | 'callback_expired') =>
    c.tg.api()?.answerCallbackQuery(cq.id, key ? { text: t(L, key) } : {}).catch(() => {})
  const m = /^ccst:(\d+):(ok|no)$/.exec(cq.data ?? '')
  const owner = c.owner()
  if (!m || !owner || cq.from.id !== owner.owner_id) return void (await answer())
  const id = Number(m[1])
  const r = task(id)
  const target = r ? c.store.topic(r.topic) : undefined
  if (!r || r.state !== 'proposed' || Date.now() - r.created_at > taskLimits.proposalTtlMs) return void (await answer('callback_expired'))
  const msg = cq.message?.message_id
  const mark = (key: 'task_sent' | 'task_cancelled') => msg === undefined ? Promise.resolve() :
    c.tg.call(api => api.editMessageReplyMarkup(owner.chat_id, msg, { reply_markup: { inline_keyboard: [[{ text: t(L, key, { topic: r.topic }), callback_data: 'ccst:x' }]] } }))
      .then(() => {}, () => {})
  if (m[2] === 'no' || !target || target.state !== 'open') {
    setState(id, 'cancelled')
    event(id, 'owner', 'cancelled')
    await answer('callback_done')
    await mark('task_cancelled')
    return
  }
  // Mark first: a second press while sending must not deliver twice.
  setState(id, 'assigned')
  event(id, 'owner', 'approved')
  await answer('callback_done')
  const text = `${t(L, 'task_assigned', { id, title: r.title })}\n\n${r.spec ?? ''}`
  const ids = await c.tg.send(r.topic, text, { format: 'markdown' })
  c.enqueueEvent(r.topic, {
    message_id: ids[0]!, user: cq.from.username ?? String(cq.from.id), user_id: String(cq.from.id), ts: new Date().toISOString(),
    text: `${t(L, 'task_assigned', { id, title: r.title })}\n\n${r.spec ?? ''}`,
    task_id: id, forwarded_from_general: { message_id: r.proposal_msg ?? msg ?? 0 },
  })
  await mark('task_sent')
  c.log('task_assigned', { id, topic: r.topic })
}

type QuestionRow = { id: number; topic: string; question: string; options: string; message_id: number | null; answer: string | null }

async function onQuestionButton(cq: NonNullable<Update['callback_query']>, c: BrokerContext): Promise<void> {
  const L = c.config.lang
  const answer = (key?: 'callback_done' | 'callback_expired') =>
    c.tg.api()?.answerCallbackQuery(cq.id, key ? { text: t(L, key) } : {}).catch(() => {})
  const m = /^ccsq:(\d+):(\d+)$/.exec(cq.data ?? '')
  const owner = c.owner()
  if (!m || !owner || cq.from.id !== owner.owner_id) return void (await answer())
  const q = c.store.db.query<QuestionRow, [number]>('SELECT * FROM questions WHERE id = ?').get(Number(m[1]))
  const options: string[] = q ? JSON.parse(q.options) : []
  const choice = options[Number(m[2])]
  const row = q ? c.store.topic(q.topic) : undefined
  if (!q || q.answer !== null || choice === undefined || !row || row.state !== 'open') return void (await answer('callback_expired'))
  c.store.db.query('UPDATE questions SET answer = ? WHERE id = ?').run(choice, q.id)
  await answer('callback_done')
  if (q.message_id !== null) {
    const { chat, id } = q.message_id < 0 ? { chat: owner.owner_id, id: -q.message_id } : { chat: owner.chat_id, id: q.message_id }
    await c.tg.call(api => api.editMessageReplyMarkup(chat, id, { reply_markup: { inline_keyboard: [[{ text: `→ ${choice}`, callback_data: 'ccsq:x' }]] } }))
      .catch(() => {})
  }
  c.enqueueEvent(q.topic, {
    message_id: q.message_id ?? 0, user: cq.from.username ?? String(cq.from.id), user_id: String(cq.from.id), ts: new Date().toISOString(),
    text: `🔘 ${choice}`, answer_to: { question_id: q.id, question: q.question },
  })
  c.log('question_answered', { topic: q.topic, qid: q.id })
}

export const tasksModule: BrokerModule = {
  name: 'tasks',
  start(c) {
    ctxRef = c
    initTables(c)
  },
  onUpdate(u, c) {
    const data = u.callback_query?.data
    if (!data) return false
    const run = data.startsWith('ccst:') ? onTaskButton : data.startsWith('ccsq:') ? onQuestionButton : null
    if (!run) return false
    void run(u.callback_query!, c).catch(e => c.log('button_failed', { err: e instanceof Error ? e.message : String(e) }))
    return true
  },
  tools: {
    propose_task: proposeTask,
    report,
    tasks: tasksTool,
    ask_owner: askOwner,
    tell_topic: tellTopic,
  },
}
// === GRACE END_BLOCK: broker_tasks ============================================
