// === GRACE START_BLOCK: broker_commands =======================================
// MODULE_CONTRACT:
//   IN:  the owner's /status, /restart, /help in a topic, General or the
//        private chat (the core routes them here instead of to the session).
//   OUT: an answer in the same topic; the bot's command menu for the group
//        (setMyCommands) once the setup is locked.
//   INV: only the owner's commands are answered; anyone else's are dropped
//        by the core's allowlist before they get here.
//   INV: /restart never closes anything itself — it posts the owner-only
//        Restart button (sessions.ts) or starts a session that is not running.

import type { Message, Update } from 'grammy/types'
import type { BrokerContext, BrokerModule } from './context.ts'
import { safeTz } from './pin.ts'
import { requestRestart } from './sessions.ts'
import { t } from './strings.ts'
import { tasksText } from './tasks.ts'

export type Command = 'status' | 'tasks' | 'restart' | 'help'

const CMD_RE = /^\/(status|tasks|restart|help)(?:@\w+)?\s*$/

export function commandOf(text: string): Command | null {
  const m = CMD_RE.exec(text.trim())
  return m ? (m[1] as Command) : null
}

function hhmm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: safeTz(tz), hour: '2-digit', minute: '2-digit' }).format(ms)
}

export function statusText(ctx: BrokerContext, topic: string): string {
  const L = ctx.config.lang
  const since = ctx.connectedSince(topic)
  const lines = [since !== null ? t(L, 'status_up', { since: hhmm(since, ctx.config.timezone) }) : t(L, 'status_down')]
  if (since !== null) lines.push(t(L, ctx.isBusy(topic) ? 'status_busy' : 'status_idle'))
  lines.push(t(L, 'status_pending', { n: ctx.pending(topic) }))
  const last = Number(ctx.store.get(`topic:${topic}:last_reply_at`) ?? 0)
  if (last) lines.push(t(L, 'status_last_reply', { at: hhmm(last, ctx.config.timezone) }))
  return lines.join('\n')
}

/** The topic a message was written in (the private chat counts as General). */
function topicOf(m: Message, ctx: BrokerContext): string | null {
  if (m.chat.type === 'private') return 'general'
  if (m.is_topic_message && m.message_thread_id !== undefined) {
    const row = ctx.store.topicByThread(m.message_thread_id)
    return row && row.state === 'open' ? row.name : null
  }
  return 'general'
}

async function run(cmd: Command, topic: string, ctx: BrokerContext): Promise<void> {
  const L = ctx.config.lang
  const say = (text: string) => ctx.tg.send(topic, text, { silent: true }).then(() => {})
  switch (cmd) {
    case 'status':
      return say(statusText(ctx, topic))
    case 'help':
      return say(t(L, 'help'))
    case 'tasks':
      return say(tasksText(ctx, topic === 'general' ? null : topic))
    case 'restart': {
      const r = await requestRestart(topic)
      if (r === 'launched') return say(t(L, 'restart_starting'))
      if (r === 'unclear') return say(t(L, 'restart_unclear'))
      return
    }
  }
}

export const commandsModule: BrokerModule = {
  name: 'commands',
  onUpdate(u: Update, ctx) {
    const m = u.message
    const owner = ctx.owner()
    if (!m?.text || !owner || m.from?.id !== owner.owner_id) return false
    const cmd = commandOf(m.text)
    if (!cmd) return false
    const topic = topicOf(m, ctx)
    if (!topic) return true
    ctx.log('command', { cmd, topic })
    // Off the poll loop: /restart may wait for a heal or a launch.
    void run(cmd, topic, ctx).catch(e => ctx.log('command_failed', { cmd, topic, err: e instanceof Error ? e.message : String(e) }))
    return true
  },
  async onLocked(ctx) {
    const owner = ctx.owner()
    if (!owner) return
    const L = ctx.config.lang
    const commands = (['status', 'tasks', 'restart', 'help'] as const).map(c => ({ command: c, description: t(L, `cmd_${c}`) }))
    await ctx.tg.call(api => api.setMyCommands(commands, { scope: { type: 'chat', chat_id: owner.chat_id } }))
      .then(() => ctx.log('commands_set', { n: commands.length }))
      .catch(e => ctx.log('commands_set_failed', { err: e instanceof Error ? e.message : String(e) }))
  },
}
// === GRACE END_BLOCK: broker_commands =========================================
