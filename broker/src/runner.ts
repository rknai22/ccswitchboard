// === GRACE START_BLOCK: broker_runner =========================================
// MODULE_CONTRACT:
//   IN:  config.runner — argv prefix that reaches the session machine (empty =
//        this machine; e.g. a container exec wrapper); argv of the command to
//        run there; optional stdin text; a timeout.
//   OUT: runOnSessionHost() → {code, stdout, stderr, timedOut, truncated};
//        readSessionFile() — a small file or null; sessionHome() — $HOME of
//        the session user, cached; expandHome() for "~/…" paths that belong
//        to the session machine. The one way every module (topics, sessions,
//        pin, digest, the CLI) reaches the session machine.
//   INV: commands are argv arrays, never shell strings: topic names, titles
//        and paths are data and must not be able to become shell syntax.
//   INV: never throws for a failed command — a non-zero exit, a timeout
//        (code -1), a missing binary (code 127) all come back as a result, so
//        a module tick cannot die on one bad call.
//   INV: a call always returns: output is capped (the pipe is still drained
//        so the child never blocks on it), and after a timeout kill the pipes
//        are dropped within 1 s — a grandchild that inherited them (a
//        container exec wrapper does this) must not hang a tick forever.
//   INV: refuses to run before initRunner(): a silent default of "this
//        machine" would run session commands on the broker host (often as
//        root) when a module forgot to pass the config.
//   INV: logs only the caller's label (or the program name), exit code and
//        duration — argv may carry a topic key.

import { log } from './context.ts'

export type RunResult = {
  /** exit code; -1 after a timeout kill, 127 when the program could not start */
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** stdout was longer than maxOutputBytes and was cut there */
  truncated: boolean
}
export type RunOpts = {
  input?: string
  timeoutMs: number
  /** safe name for logs */
  label?: string
  /** stdout cap, bytes (default 4 MiB); stderr is capped at 16 KiB */
  maxOutputBytes?: number
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024
const MAX_STDERR = 16 * 1024
const PIPE_DROP_MS = 1000
const READ_TIMEOUT_MS = 15_000
export const MAX_SESSION_FILE_BYTES = 256 * 1024

let prefix: string[] | null = null
let homePromise: Promise<string> | null = null

export function initRunner(cfg: { runner: string[] }): void {
  const next = [...cfg.runner]
  if (prefix && prefix.join('\0') !== next.join('\0')) homePromise = null
  prefix = next
}

type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }

async function readCapped(reader: Reader, cap: number): Promise<{ text: string; total: number }> {
  const parts: Uint8Array[] = []
  let n = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      // Keep draining past the cap so the child never blocks on a full pipe.
      if (n < cap) parts.push(value.subarray(0, Math.min(value.length, cap - n)))
      n += value.length
    }
  } catch {
    // cancelled after a timeout kill: keep what was read
  }
  return { text: Buffer.concat(parts).toString('utf8'), total: n }
}

export async function runOnSessionHost(argv: string[], opts: RunOpts): Promise<RunResult> {
  if (!prefix) throw new Error('runner is not initialized (initRunner(config) first)')
  const full = [...prefix, ...argv]
  const label = opts.label ?? argv[0] ?? '?'
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const started = Date.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(full, {
      stdin: opts.input !== undefined ? Buffer.from(opts.input) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log('runner', 'spawn_failed', { label, err: msg })
    return { code: 127, stdout: '', stderr: msg, timedOut: false, truncated: false }
  }
  const out = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const err = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  let timedOut = false
  let drop: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
    drop = setTimeout(() => {
      void out.cancel().catch(() => {})
      void err.cancel().catch(() => {})
    }, PIPE_DROP_MS)
  }, opts.timeoutMs)
  try {
    const [o, e] = await Promise.all([readCapped(out, cap), readCapped(err, MAX_STDERR)])
    const exit = await proc.exited
    const res: RunResult = {
      code: timedOut ? -1 : exit, stdout: o.text, stderr: e.text, timedOut, truncated: o.total > cap,
    }
    log('runner', 'run', { label, code: res.code, timed_out: timedOut, ms: Date.now() - started, out_len: o.total })
    return res
  } finally {
    clearTimeout(timer)
    clearTimeout(drop)
  }
}

/** $HOME of the session user on the session machine; cached once it worked. */
export function sessionHome(): Promise<string> {
  if (!homePromise) {
    homePromise = runOnSessionHost(['sh', '-c', 'printf %s "$HOME"'], { timeoutMs: 15_000, label: 'home' }).then(r => {
      const h = r.stdout.trim()
      if (r.code !== 0 || !h.startsWith('/')) {
        homePromise = null
        throw new Error(`cannot read $HOME on the session machine (exit ${r.code})`)
      }
      return h.replace(/\/+$/, '') || '/'
    })
  }
  return homePromise
}

/** "~" and "~/x" against the session user's home; other paths unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p
}

/**
 * A small file on the session machine, or null (absent, unreadable, larger
 * than 256 KB, timed out, or the session machine is unreachable). "~/" is the
 * session user's home (sessionHome) — the same rule the sessions module uses.
 */
export async function readSessionFile(path: string, timeoutMs = READ_TIMEOUT_MS): Promise<string | null> {
  try {
    const full = path === '~' || path.startsWith('~/') ? expandHome(path, await sessionHome()) : path
    const r = await runOnSessionHost(['cat', '--', full], {
      timeoutMs, label: 'read_file', maxOutputBytes: MAX_SESSION_FILE_BYTES,
    })
    if (r.code !== 0 || r.truncated) return null
    return r.stdout
  } catch {
    return null
  }
}
// === GRACE END_BLOCK: broker_runner ===========================================
