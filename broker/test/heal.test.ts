import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { emptyHeal, healDecision, healTiming, repoIdFor } from '../src/heal.ts'
import { onRestartCallback, sessionsModule } from '../src/sessions.ts'
import { Store } from '../src/store.ts'
import { tempDir } from './helpers.ts'

const now = 10_000_000

test('healDecision: fewer than 2 strikes → wait', () => {
  expect(healDecision({ ...emptyHeal(), strikes: 1 }, 600, now)).toBe('wait')
})
test('healDecision: Claude younger than 120 s → wait', () => {
  expect(healDecision({ ...emptyHeal(), strikes: 2 }, 60, now)).toBe('wait')
})
test('healDecision: last heal under 300 s ago → wait', () => {
  expect(healDecision({ ...emptyHeal(), strikes: 5, lastAt: now - 299_000 }, 600, now)).toBe('wait')
})
test('healDecision: otherwise heal; unknown age counts as old', () => {
  expect(healDecision({ ...emptyHeal(), strikes: 2, lastAt: now - 301_000 }, null, now)).toBe('heal')
})
test('healDecision: 3 failures → ask the owner, then not again for 15 min', () => {
  expect(healDecision({ ...emptyHeal(), strikes: 9, fails: healTiming.maxFails }, 600, now)).toBe('ask_owner')
  expect(healDecision({ ...emptyHeal(), strikes: 9, fails: 3, askedAt: now - 60_000 }, 600, now)).toBe('wait')
})

test('repoIdFor finds the project by path, trailing slash ignored', () => {
  const list = { ok: true, result: { repos: [{ id: 'r1', path: '/p/a' }, { id: 'r2', path: '/p/b' }] } }
  expect(repoIdFor(list, '/p/b/')).toBe('r2')
  expect(repoIdFor(list, '/p/c')).toBeUndefined()
  expect(repoIdFor(undefined, '/p/a')).toBeUndefined()
})

// ---- Restart button --------------------------------------------------------------

const tmp = tempDir()
const calls = join(tmp.dir, 'orca-calls.log')
const orca = join(tmp.dir, 'orca')
let store: Store
const answers: (string | undefined)[] = []

beforeAll(() => {
  // A fake orca: logs its argv, lists one terminal (term_live) in /p/wms.
  writeFileSync(orca, `#!/bin/sh
echo "$@" >> ${calls}
case "$1 $2" in
  "terminal list") echo '{"ok":true,"result":{"terminals":[{"handle":"term_live","worktreePath":"/p/wms"}]}}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
`)
  chmodSync(orca, 0o755)
  store = new Store(tmp.dir)
  store.createTopic({ name: 'wms', chat_id: -100, thread_id: 7, cwd: '/p/wms' })
  sessionsModule.start!({
    config: { runner: [], orca, lang: 'en', heal: true, claude_cmd: 'claude', projects_root: '/p' } as any,
    store,
    tg: { api: () => ({ answerCallbackQuery: async (_id: string, o: any) => { answers.push(o?.text) } }), send: async () => [1] } as any,
    owner: () => ({ owner_id: 42, chat_id: -100 }),
    isConnected: () => false,
    isLocked: () => true,
    log: () => {},
  } as any)
})
afterAll(() => {
  store.close()
  tmp.rm()
})

const cq = (from: number, data: string) => ({ id: 'cb', from: { id: from }, data }) as any
const orcaCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')

test('a press by someone else is ignored', async () => {
  store.set('topic:wms:restart', JSON.stringify({ nonce: 'n1', handle: 'term_live', expires: Date.now() + 60_000 }))
  await onRestartCallback(cq(7, 'ccsr:wms:n1'))
  expect(answers.at(-1)).toBeUndefined()
  expect(orcaCalls()).not.toContain('terminal close')
  expect(store.get('topic:wms:restart')).toBeDefined()
})

test('a stale nonce → expired, nothing closed', async () => {
  await onRestartCallback(cq(42, 'ccsr:wms:old'))
  expect(answers.at(-1)).toBe('Expired.')
  expect(orcaCalls()).not.toContain('terminal close')
})

test('the terminal in the button is gone → nothing closed', async () => {
  store.set('topic:wms:restart', JSON.stringify({ nonce: 'n2', handle: 'term_gone', expires: Date.now() + 60_000 }))
  await onRestartCallback(cq(42, 'ccsr:wms:n2'))
  expect(answers.at(-1)).toMatch(/already gone/)
  expect(orcaCalls()).not.toContain('terminal close')
})
