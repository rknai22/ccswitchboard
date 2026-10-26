// === GRACE START_BLOCK: broker_runner =========================================
// MODULE_CONTRACT:
//   IN:  config.runner — argv prefix that reaches the session machine (empty =
//        this machine; e.g. a container exec wrapper); argv of the command to
//        run there; optional stdin text; a timeout.
//   OUT: runOnSessionHost() → {code, stdout, stderr, timedOut}; sessionHome()
//        — $HOME of the session user, cached; expandHome() for "~/…" paths
//        that belong to the session machine.
//   INV: commands are argv arrays, never shell strings: topic names and titles
//        are data and must not be able to become shell syntax.
//   INV: never throws for a failed command — a non-zero exit, a timeout or a
//        missing binary all come back as a result, so a watchdog tick cannot
//        die on one bad call.
//   INV: refuses to run before initRunner(): a silent default of "this
//        machine" would run session commands on the broker host (often as
//        root) when a module forgot to pass the config.
//   INV: logs only the caller's label (or the program name), exit code and
//        duration — argv may carry a topic key.

import { log } from './context.ts'

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOpts = { input?: string; timeoutMs: number; /** safe name for logs */ label?: string }

let prefix: string[] | null = null
let homePromise: Promise<string> | null = null

export function initRunner(cfg: { runner: string[] }): void {
  const next = [...cfg.runner]
  if (prefix && prefix.join('\0') !== next.join('\0')) homePromise = null
  prefix = next
}

export async function runOnSessionHost(argv: string[], opts: RunOpts): Promise<RunResult> {
  if (!prefix) throw new Error('runner is not initialized (initRunner(config) first)')
  const full = [...prefix, ...argv]
  const label = opts.label ?? argv[0] ?? '?'
  const started = Date.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(full, {
      stdin: opts.input !== undefined ? Buffer.from(opts.input) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e) {
    log('runner', 'spawn_failed', { label, err: e instanceof Error ? e.message : String(e) })
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, opts.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  const res = { code: timedOut ? -1 : code, stdout, stderr, timedOut }
  log('runner', 'run', { label, code: res.code, timed_out: timedOut, ms: Date.now() - started, out_len: stdout.length })
  return res
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
// === GRACE END_BLOCK: broker_runner ===========================================
