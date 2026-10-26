// === GRACE START_BLOCK: broker_config =========================================
// MODULE_CONTRACT:
//   IN:  path to the admin-owned config.json (read-only for the broker);
//        <state_dir>/secret.json written by the setup wizard.
//   OUT: Config with defaults applied; Secret read/write/delete helpers.
//   INV: config.json is never written by the broker — the wizard stores the
//        token in secret.json instead, so an admin can keep config.json
//        read-only and under version control.
//   INV: secret.json is 0600 and replaced atomically (tmp + rename): a crash
//        mid-write leaves either the old or the new secret, never half a file.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

export type Lang = 'ru' | 'en'

export type Config = {
  listen: string
  state_dir: string
  api_root: string
  lang: Lang
  // Wave B fields: parsed and passed through, unused by the core.
  runner: string[]
  orca: string
  projects_root: string
  claude_cmd: string
  usage_file?: string
  timezone: string
  digest_at: string
}

export type Secret = {
  bot_token: string
  owner_id?: number
  chat_id?: number
  locked: boolean
}

const DEFAULTS: Config = {
  listen: '127.0.0.1:2223',
  state_dir: '/var/lib/ccswitchboard',
  api_root: 'https://api.telegram.org',
  lang: 'en',
  runner: [],
  orca: 'orca',
  projects_root: '~/projects',
  claude_cmd: 'claude --channels plugin:ccswitchboard@ccswitchboard --dangerously-skip-permissions',
  timezone: 'Europe/Moscow',
  digest_at: '10:00',
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
  const cfg: Config = { ...DEFAULTS, ...raw }
  if (cfg.lang !== 'ru' && cfg.lang !== 'en') cfg.lang = 'en'
  if (!Array.isArray(cfg.runner) || !cfg.runner.every(x => typeof x === 'string')) {
    throw new Error('config: runner must be an array of strings')
  }
  // state_dir is the broker's own machine path; projects_root belongs to the
  // session machine, so it is left for wave B to expand there.
  cfg.state_dir = resolve(expandHome(cfg.state_dir))
  cfg.api_root = cfg.api_root.replace(/\/+$/, '')
  return cfg
}

export function ensureStateDir(cfg: Config): void {
  mkdirSync(cfg.state_dir, { recursive: true, mode: 0o700 })
  try { chmodSync(cfg.state_dir, 0o700) } catch {}
}

function secretPath(cfg: Config): string {
  return join(cfg.state_dir, 'secret.json')
}

export function readSecret(cfg: Config): Secret | null {
  const p = secretPath(cfg)
  if (!existsSync(p)) return null
  const s = JSON.parse(readFileSync(p, 'utf8')) as Partial<Secret>
  if (typeof s.bot_token !== 'string' || !s.bot_token) return null
  return {
    bot_token: s.bot_token,
    owner_id: typeof s.owner_id === 'number' ? s.owner_id : undefined,
    chat_id: typeof s.chat_id === 'number' ? s.chat_id : undefined,
    locked: s.locked === true,
  }
}

export function writeSecret(cfg: Config, s: Secret): void {
  ensureStateDir(cfg)
  const p = secretPath(cfg)
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
}

export function deleteSecret(cfg: Config): void {
  rmSync(secretPath(cfg), { force: true })
}

/** Telegram tokens are "<bot_id>:<secret>"; the id is safe to log and key by. */
export function botIdOf(token: string): string {
  const id = token.split(':')[0] ?? ''
  return /^\d+$/.test(id) ? id : 'unknown'
}
// === GRACE END_BLOCK: broker_config ===========================================
