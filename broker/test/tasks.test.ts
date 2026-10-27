import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Broker } from '../src/broker.ts'
import { tasksModule, taskLimits, tasksText } from '../src/tasks.ts'
import { sleep, tempDir } from './helpers.ts'

let tmp: ReturnType<typeof tempDir>
let b: Broker
let sent: { chat: number; text: string; opts: any }[]
let edits: any[]
let answers: (string | undefined)[]
let next = 100

const general = { id: 1, mode: 'topic', topic: 'general' } as const
const wms = { id: 2, mode: 'topic', topic: 'wms' } as const
const crm = { id: 3, mode: 'topic', topic: 'crm' } as const

beforeEach(async () => {
  sent = []; edits = []; answers = []
  tmp = tempDir()
  b = new Broker({ state_dir: tmp.dir, lang: 'en', api_root: '', listen: '127.0.0.1:1', timezone: 'UTC' } as any, [tasksModule])
  ;(b as any).sec = { bot_token: 't', owner_id: 42, chat_id: -100, locked: true }
  b.store.createTopic({ name: 'general', chat_id: -100, thread_id: null })
  b.store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7 })
  b.store.createTopic({ name: 'crm', chat_id: -100, thread_id: 8 })
  const api = {
    sendMessage: async (chat: number, text: string, opts: any) => { sent.push({ chat, text, opts }); return { message_id: next++ } },
    editMessageReplyMarkup: async (...a: any[]) => { edits.push(a); return true },
    answerCallbackQuery: async (_id: string, o: any) => { answers.push(o?.text); return true },
    sendChatAction: async () => true,
    setMessageReaction: async () => true,
  }
  ;(b.tg as any).enqueue = (_c: number, _m: boolean, fn: (a: any) => Promise<any>) => fn(api)
  ;(b.tg as any).api = () => api
  for (const m of [tasksModule]) await m.start!((b as any).ctxFor(m))
})
afterEach(() => {
  b.stop()
  tmp.rm()
})

const call = (tool: string, args: object, conn: any) => (b as any).handleTool(tool, args, conn)
const press = async (data: string, from = 42) => {
  await (b as any).handleUpdate({ update_id: next++, callback_query: { id: 'cb', from: { id: from }, data, message: { message_id: 999, chat: { id: -100 } } } })
  await sleep(30)
}
const queued = (topic: string) => b.store.undelivered(topic)

test('propose_task only from General', async () => {
  await expect(call('propose_task', { topic: 'crm', title: 't', spec: 's' }, wms)).rejects.toThrow(/only the General/)
})

test('proposal → owner ✅ → the spec reaches the topic as the owner\'s words with task_id', async () => {
  const r = await call('propose_task', { topic: 'wms', title: 'Fix login', spec: '**Goal**: fix it' }, general)
  expect(sent.at(-1)!.opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`ccst:${r.task_id}:ok`)
  expect(queued('wms')).toHaveLength(0)
  await press(`ccst:${r.task_id}:ok`)
  const ev = queued('wms')
  expect(ev).toHaveLength(1)
  expect(ev[0]!.task_id).toBe(r.task_id)
  expect(ev[0]!.user_id).toBe('42')
  expect(ev[0]!.text).toContain('**Goal**: fix it')
  expect(ev[0]!.forwarded_from_general).toBeDefined()
  // A second press does nothing.
  await press(`ccst:${r.task_id}:ok`)
  expect(queued('wms')).toHaveLength(1)
  expect(answers.at(-1)).toBe('Expired.')
})

test('someone else\'s press, a cancel, an expired proposal → nothing delivered', async () => {
  const a = await call('propose_task', { topic: 'wms', title: 'A', spec: 's' }, general)
  await press(`ccst:${a.task_id}:ok`, 7)
  await press(`ccst:${a.task_id}:no`)
  await press(`ccst:${a.task_id}:ok`)
  const old = await call('propose_task', { topic: 'wms', title: 'B', spec: 's' }, general)
  b.store.db.query('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - taskLimits.proposalTtlMs - 1, old.task_id)
  await press(`ccst:${old.task_id}:ok`)
  expect(queued('wms')).toHaveLength(0)
})

test('report: new task, own task only, done is announced in General', async () => {
  const r = await call('report', { title: 'Migrate DB', state: 'in_progress', summary: 'started' }, wms)
  const before = sent.length
  await expect(call('report', { task_id: r.task_id, state: 'done', summary: 'x' }, crm)).rejects.toThrow(/belongs to topic wms/)
  await call('report', { task_id: r.task_id, state: 'done', summary: 'all migrated' }, wms)
  expect(sent.length).toBe(before + 1)
  expect(sent.at(-1)!.text).toContain('wms #' + r.task_id)
  expect(sent.at(-1)!.text).toContain('all migrated')
})

test('in_progress is not announced', async () => {
  await call('report', { title: 'X', state: 'in_progress', summary: 's' }, wms)
  expect(sent).toHaveLength(0)
})

test('tasks: General sees all, a topic only its own; report age is there', async () => {
  await call('report', { title: 'W', state: 'in_progress', summary: 's' }, wms)
  await call('report', { title: 'C', state: 'blocked', summary: 's' }, crm)
  expect((await call('tasks', {}, general)).tasks.map((x: any) => x.topic).sort()).toEqual(['crm', 'wms'])
  expect((await call('tasks', {}, wms)).tasks.map((x: any) => x.topic)).toEqual(['wms'])
  await expect(call('tasks', { topic: 'crm' }, wms)).rejects.toThrow(/only its own/)
  expect((await call('tasks', {}, wms)).tasks[0].report_age_min).toBe(0)
  expect(tasksText((b as any).base, null)).toContain('crm #')
})

test('ask_owner → owner press → the session gets the answer; the buttons go', async () => {
  const q = await call('ask_owner', { question: 'Push branch x?' }, wms)
  const kb = sent.at(-1)!.opts.reply_markup.inline_keyboard
  expect(kb.map((r: any) => r[0].text)).toEqual(['✅ Yes', '❌ No'])
  await press(`ccsq:${q.question_id}:0`, 7)
  expect(queued('wms')).toHaveLength(0)
  await press(`ccsq:${q.question_id}:0`)
  const ev = queued('wms')
  expect(ev).toHaveLength(1)
  expect(ev[0]!.text).toBe('🔘 ✅ Yes')
  expect(ev[0]!.answer_to).toEqual({ question_id: q.question_id, question: 'Push branch x?' })
  expect(edits).toHaveLength(1)
  await press(`ccsq:${q.question_id}:1`)
  expect(queued('wms')).toHaveLength(1)
})

test('tell_topic: visible copy, from_topic, not the owner; no General; hourly limit', async () => {
  await call('tell_topic', { topic: 'crm', text: 'API changed' }, wms)
  const ev = queued('crm')
  expect(ev[0]!.from_topic).toBe('wms')
  expect(ev[0]!.user_id).toBe('0')
  expect(sent.at(-1)!.text).toContain('API changed')
  expect(sent.at(-1)!.opts.disable_notification).toBe(true)
  await expect(call('tell_topic', { topic: 'general', text: 'x' }, wms)).rejects.toThrow(/General/)
  for (let i = 1; i < taskLimits.tellPerHour; i++) await call('tell_topic', { topic: 'crm', text: `m${i}` }, wms)
  await expect(call('tell_topic', { topic: 'crm', text: 'over' }, wms)).rejects.toThrow(/limit/)
})

test('a spec too long to see on one screen is refused', async () => {
  await expect(call('propose_task', { topic: 'wms', title: 'L', spec: 'x'.repeat(taskLimits.specChars + 1) }, general)).rejects.toThrow(/one screen/)
})

test('collapsed quotes are opened in a proposal', async () => {
  await call('propose_task', { topic: 'wms', title: 'Q', spec: '>> hidden part' }, general)
  expect(sent.at(-1)!.text).not.toContain('expandable')
})

test('sending the approved task fails → back to proposed, the button works again', async () => {
  const r = await call('propose_task', { topic: 'wms', title: 'F', spec: 's' }, general)
  const real = (b.tg as any).enqueue
  let fail = true
  ;(b.tg as any).enqueue = (c: number, m: boolean, fn: any) => (fail && c === -100 && m ? (fail = false, Promise.reject(new Error('net'))) : real(c, m, fn))
  await press(`ccst:${r.task_id}:ok`)
  expect(queued('wms')).toHaveLength(0)
  ;(b.tg as any).enqueue = real
  await press(`ccst:${r.task_id}:ok`)
  expect(queued('wms')).toHaveLength(1)
})

test('no reports on a cancelled task', async () => {
  const r = await call('propose_task', { topic: 'wms', title: 'C', spec: 's' }, general)
  await press(`ccst:${r.task_id}:no`)
  await expect(call('report', { task_id: r.task_id, state: 'done', summary: 'x' }, wms)).rejects.toThrow(/cancelled/)
})

test('loud notices are capped per topic per hour', async () => {
  const r = await call('report', { title: 'N', state: 'in_progress', summary: 's' }, wms)
  const before = sent.length
  for (let i = 0; i < taskLimits.noticesPerHour + 3; i++) await call('report', { task_id: r.task_id, state: 'blocked', summary: `b${i}` }, wms)
  // The cap, plus one note that the rest of the hour is muted.
  expect(sent.length - before).toBe(taskLimits.noticesPerHour + 1)
  expect(sent.at(-1)!.text).toContain('muted')
})

test('>>> in a spec does not survive as a collapsed quote', async () => {
  await call('propose_task', { topic: 'wms', title: 'Q3', spec: '>>> hidden' }, general)
  expect(sent.at(-1)!.text).not.toContain('expandable')
})
