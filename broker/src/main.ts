#!/usr/bin/env bun
// === GRACE START_BLOCK: broker_cli ============================================
// MODULE_CONTRACT:
//   IN:  argv: <serve|reset|status|key <topic>|digest --now> --config <path>.
//   OUT: serve — runs the broker until SIGTERM/SIGINT;
//        reset — wipes the setup without the Telegram button (lost bot),
//          prints "reset done"; a running broker notices within ~5 s;
//        status — setup state, bot, group, topic and queue counts;
//        key <topic> — prints the topic's key (root or the DB owner only);
//        digest --now — builds the morning digest and sends it to General
//          right away (does not count as the day's scheduled one).
//   INV: status never prints the token or topic keys; only `key` prints a key.
//   INV: umask 077 — every file the broker creates (DB, WAL, secret) is
//        private to its user.

import { statSync } from 'fs'
import { ensureStateDir, loadConfig, readSecret } from './config.ts'
import { Broker } from './broker.ts'
import { log } from './context.ts'
import { Store } from './store.ts'
import { wipeSetup } from './setup.ts'
import { buildDigest } from './digest.ts'
import { initRunner } from './runner.ts'
import { Telegram, describeError } from './telegram.ts'

process.umask(0o077)

const USAGE = 'usage: bun broker/src/main.ts <serve|reset|status|key <topic>|digest --now> --config <path>'

function parseArgs(argv: string[]): { cmd: string; rest: string[]; config: string } {
  const rest: string[] = []
  let config = process.env.CCSB_BROKER_CONFIG ?? ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') config = argv[++i] ?? ''
    else if (argv[i]!.startsWith('--config=')) config = argv[i]!.slice('--config='.length)
    else rest.push(argv[i]!)
  }
  const [cmd = '', ...tail] = rest
  if (!cmd || !config) {
    process.stderr.write(USAGE + '\n')
    process.exit(2)
  }
  return { cmd, rest: tail, config }
}

const { cmd, rest, config } = parseArgs(process.argv.slice(2))
const cfg = loadConfig(config)

switch (cmd) {
  case 'serve': {
    // Last-resort net: a stray rejection must not take the only poller down.
    process.on('unhandledRejection', e => log('core', 'unhandled_rejection', { err: String(e) }))
    process.on('uncaughtException', e => log('core', 'uncaught_exception', { err: String(e) }))
    const broker = new Broker(cfg)
    const stop = (sig: string) => {
      log('core', 'shutdown', { signal: sig })
      broker.stop()
      process.exit(0)
    }
    process.on('SIGTERM', () => stop('SIGTERM'))
    process.on('SIGINT', () => stop('SIGINT'))
    await broker.start()
    break
  }
  case 'reset': {
    ensureStateDir(cfg)
    const store = new Store(cfg.state_dir)
    wipeSetup(cfg, store)
    store.close()
    log('cli', 'reset_done')
    process.stdout.write('reset done\n')
    break
  }
  case 'status': {
    ensureStateDir(cfg)
    const store = new Store(cfg.state_dir)
    const s = readSecret(cfg)
    const state = !s ? 'unconfigured' : s.locked ? 'locked' : (store.get('setup_state') ?? 'waiting_chat')
    const topics = store.topics()
    const lines = [
      `state: ${state}`,
      `bot: ${s && store.get('bot_username') ? '@' + store.get('bot_username') : '-'}`,
      `group: ${store.get('chat_title') ?? '-'}${s?.chat_id !== undefined ? ` (${s.chat_id})` : ''}`,
      `owner_id: ${s?.owner_id ?? '-'}`,
      `topics: ${topics.length} (open ${topics.filter(x => x.state === 'open').length})`,
      `undelivered: ${store.countUndelivered()}`,
    ]
    store.close()
    process.stdout.write(lines.join('\n') + '\n')
    break
  }
  case 'key': {
    const name = rest[0]
    if (!name) {
      process.stderr.write(USAGE + '\n')
      process.exit(2)
    }
    const store = new Store(cfg.state_dir)
    const uid = process.getuid?.()
    if (uid !== 0 && uid !== statSync(store.path).uid) {
      process.stderr.write('key: only root or the owner of the state database may read topic keys\n')
      process.exit(1)
    }
    const row = store.topic(name)
    store.close()
    if (!row) {
      process.stderr.write(`key: no topic ${name}\n`)
      process.exit(1)
    }
    process.stdout.write(row.key + '\n')
    break
  }
  case 'digest': {
    if (rest[0] !== '--now') {
      process.stderr.write(USAGE + '\n')
      process.exit(2)
    }
    const s = readSecret(cfg)
    if (!s?.locked || s.chat_id === undefined) {
      process.stderr.write('digest: the broker is not configured yet\n')
      process.exit(1)
    }
    ensureStateDir(cfg)
    const store = new Store(cfg.state_dir)
    initRunner(cfg)
    // A send-only client: no polling here, the serving broker keeps getUpdates.
    const tg = new Telegram(cfg, store, { onUpdate: async () => {}, onConflict: () => {}, allowedUpdates: () => [] })
    tg.setToken(s.bot_token)
    try {
      const text = await buildDigest(cfg, store, new Date(), (ev, f) => log('digest', ev, f))
      const ids = await tg.sendInto(s.chat_id, null, text, { onSent: id => store.rememberMessage(id, 'general') })
      log('digest', 'digest_sent_now', { messages: ids.length, len: text.length })
      process.stdout.write(`digest sent (${ids.length} message${ids.length === 1 ? '' : 's'})\n`)
    } catch (e) {
      process.stderr.write(`digest: ${describeError(e)}\n`)
      process.exitCode = 1
    } finally {
      store.close()
    }
    break
  }
  default:
    process.stderr.write(USAGE + '\n')
    process.exit(2)
}
// === GRACE END_BLOCK: broker_cli ==============================================
