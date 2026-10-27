// === GRACE START_BLOCK: broker_panel ==========================================
// MODULE_CONTRACT:
//   IN:  config.panel_listen / panel_url / panel_tunnel; HTTP requests from the
//        owner's Telegram (Mini App) carrying initData; the topic registry,
//        tasks, connection state and the usage file.
//   OUT: the panel page (GET /), its data (GET /api/state) and actions
//        (POST /api/restart, /api/stop); with panel_tunnel 'cloudflared' a
//        quick tunnel whose URL is followed; the owner's private-chat menu
//        button "📊 Panel" pointing at the current URL; /panel answers.
//   INV: every /api call needs initData signed with the bot token (checked
//        by the core: verifyWebApp) and opened by the owner; anything else
//        gets 401 and no data. The page itself holds no data.
//   INV: the page is dark only — it ignores Telegram's theme (owner's choice).
//   INV: actions go through the same paths as Telegram: /api/restart posts
//        the owner-only Restart button (requestRestart), never closes a
//        terminal by itself; /api/stop sends Esc to the topic's only terminal.

import type { Subprocess } from 'bun'
import type { BrokerContext, BrokerModule } from './context.ts'
import { loadUsage } from './pin.ts'
import { requestRestart, sendEscape } from './sessions.ts'
import { t } from './strings.ts'
import { listTasks, view } from './tasks.ts'

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

let ctxRef: BrokerContext | null = null
let server: ReturnType<typeof Bun.serve> | null = null
let tunnel: Subprocess | null = null
let tunnelBackoff = 5_000
let stopping = false

export function panelUrl(c: BrokerContext): string {
  return c.config.panel_url || c.store.get('panel:url') || ''
}

export async function panelState(c: BrokerContext) {
  const u = await loadUsage(c.config).catch(() => null)
  const tasks = listTasks(undefined, true).map(r => view(r, c))
  return {
    lang: c.config.lang,
    now: Date.now(),
    limits: u && !u.error
      ? {
        five_hour: u.five_hour ? { pct: u.five_hour.pct, resets_at: u.five_hour.resets_at?.toISOString() ?? null } : null,
        week: u.week ? { pct: u.week.pct, resets_at: u.week.resets_at?.toISOString() ?? null } : null,
        as_of: u.ts?.toISOString() ?? null,
      }
      : null,
    codex: u?.codex && (u.codex.five_hour || u.codex.week)
      ? {
        five_hour: u.codex.five_hour ? { pct: u.codex.five_hour.pct, resets_at: u.codex.five_hour.resets_at?.toISOString() ?? null } : null,
        week: u.codex.week ? { pct: u.codex.week.pct, resets_at: u.codex.week.resets_at?.toISOString() ?? null } : null,
        as_of: u.codex.as_of?.toISOString() ?? null,
      }
      : null,
    topics: c.store.topics().filter(r => r.state === 'open').map(r => ({
      name: r.name,
      title: r.title ?? r.name,
      connected_since: c.connectedSince(r.name),
      busy: c.isBusy(r.name),
      pending: c.pending(r.name),
      last_reply_at: Number(c.store.get(`topic:${r.name}:last_reply_at`) ?? 0) || null,
      tasks: tasks.filter(x => x.topic === r.name),
    })),
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/** The request's opener when it is the owner; null otherwise. */
function owner(req: Request, c: BrokerContext): number | null {
  const o = c.owner()
  const init = req.headers.get('x-telegram-init-data') ?? ''
  const id = init ? c.verifyWebApp(init) : null
  return o && id === o.owner_id ? id : null
}

export async function handle(req: Request, c: BrokerContext): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 })
  if (owner(req, c) === null) {
    c.log('panel_denied', { path: url.pathname })
    return json({ error: 'forbidden' }, 401)
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(await panelState(c))
  if (req.method === 'POST' && (url.pathname === '/api/restart' || url.pathname === '/api/stop')) {
    let topic = ''
    try {
      topic = String(((await req.json()) as { topic?: unknown }).topic ?? '')
    } catch {}
    const row = c.store.topic(topic)
    if (!row || row.state !== 'open') return json({ error: 'no such topic' }, 400)
    c.log('panel_action', { action: url.pathname.slice(5), topic })
    if (url.pathname === '/api/stop') return json({ ok: await sendEscape(topic) })
    return json({ result: await requestRestart(topic) })
  }
  return json({ error: 'not found' }, 404)
}

async function setMenuButton(c: BrokerContext, url: string): Promise<void> {
  const o = c.owner()
  if (!o || !url) return
  await c.tg.call(api => api.setChatMenuButton({
    chat_id: o.owner_id,
    menu_button: { type: 'web_app', text: t(c.config.lang, 'panel_button'), web_app: { url } },
  })).then(
    () => c.log('panel_menu_set', {}),
    e => c.log('panel_menu_failed', { err: e instanceof Error ? e.message : String(e) }),
  )
}

/** Run a Cloudflare quick tunnel to the panel and follow its URL. */
function startTunnel(c: BrokerContext): void {
  if (stopping) return
  const target = `http://${c.config.panel_listen}`
  try {
    tunnel = Bun.spawn([c.config.cloudflared, 'tunnel', '--no-autoupdate', '--url', target], { stdout: 'ignore', stderr: 'pipe' })
  } catch (e) {
    c.log('tunnel_spawn_failed', { err: e instanceof Error ? e.message : String(e) })
    setTimeout(() => startTunnel(c), tunnelBackoff).unref?.()
    tunnelBackoff = Math.min(tunnelBackoff * 2, 300_000)
    return
  }
  const started = Date.now()
  void (async () => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of tunnel!.stderr as ReadableStream<Uint8Array>) {
      buf = (buf + dec.decode(chunk)).slice(-4096)
      const m = TUNNEL_URL_RE.exec(buf)
      if (m && m[0] !== c.store.get('panel:url')) {
        c.store.set('panel:url', m[0])
        c.log('tunnel_url', { host: new URL(m[0]).host })
        tunnelBackoff = 5_000
        await setMenuButton(c, m[0])
      }
    }
  })().catch(() => {})
  void tunnel.exited.then(code => {
    c.log('tunnel_exited', { code, ran_s: Math.round((Date.now() - started) / 1000) })
    tunnel = null
    if (stopping) return
    setTimeout(() => startTunnel(c), tunnelBackoff).unref?.()
    tunnelBackoff = Math.min(tunnelBackoff * 2, 300_000)
  })
}

export const panelModule: BrokerModule = {
  name: 'panel',
  start(c) {
    ctxRef = c
    if (!c.config.panel_listen) return
    const i = c.config.panel_listen.lastIndexOf(':')
    const hostname = c.config.panel_listen.slice(0, i)
    const port = Number(c.config.panel_listen.slice(i + 1))
    server = Bun.serve({ hostname, port, fetch: req => handle(req, ctxRef!) })
    c.log('panel_listen', { hostname, port })
    if (c.config.panel_tunnel === 'cloudflared') startTunnel(c)
  },
  async onLocked(c) {
    const url = panelUrl(c)
    if (url) await setMenuButton(c, url)
  },
}

/** For tests and shutdown. */
export function stopPanel(): void {
  stopping = true
  tunnel?.kill()
  server?.stop(true)
  server = null
}

// The page: plain HTML + JS, Telegram's WebApp script for initData and theme.
const PAGE = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccswitchboard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--hint:#8b919a;--card:#1a1d23;--line:#2a2e36;--btn:#3b82f6;--btnfg:#fff;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif}
h1{font-size:18px;margin:0 0 12px}.card{background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px}
.row{display:flex;align-items:center;gap:8px}.grow{flex:1;min-width:0}.hint{color:var(--hint);font-size:13px}
.dot{width:10px;height:10px;border-radius:50%;flex:none}.up{background:#22c55e}.down{background:#ef4444}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:4px 0 8px}.bar>i{display:block;height:100%}
.task{padding:6px 0;border-top:1px solid var(--line)}.task:first-child{border-top:0}
.old{color:#f59e0b}button{border:0;border-radius:8px;padding:6px 10px;background:var(--btn);color:var(--btnfg);font-size:13px}
button.ghost{background:transparent;color:var(--btn);border:1px solid var(--btn)}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#err{color:#ef4444}
</style></head><body>
<h1 id="h">ccswitchboard</h1><div id="err"></div><div id="limits"></div><div id="topics"></div>
<script>
const tg = window.Telegram && Telegram.WebApp; tg && tg.ready(); tg && tg.expand()
// Dark only, whatever the Telegram theme (the owner's choice).
try { tg && tg.setHeaderColor('#0f1115'); tg && tg.setBackgroundColor('#0f1115'); tg && tg.setBottomBarColor && tg.setBottomBarColor('#0f1115') } catch (e) {}
const T = {
  ru:{codex:'Лимиты ChatGPT',limits:'Лимиты Claude',five:'5 часов',week:'Неделя',asof:'на',up:'на связи',down:'не на связи',busy:'работает',idle:'свободна',
      pending:'ждут доставки',noTasks:'задач нет',min:'мин назад',restart:'Перезапустить',stop:'Стоп',sent:'Готово',
      forbidden:'Открой панель из Telegram (кнопка в личке с ботом).',confirmStop:'Прервать текущую работу сессии',confirmRestart:'Перезапустить сессию',
      states:{proposed:'📝',assigned:'📋',in_progress:'⚙️',waiting_owner:'⏳',blocked:'🟥',done:'✅',cancelled:'✖️'}},
  en:{codex:'ChatGPT limits',limits:'Claude limits',five:'5 hours',week:'Week',asof:'as of',up:'connected',down:'not connected',busy:'working',idle:'idle',
      pending:'waiting for delivery',noTasks:'no tasks',min:'min ago',restart:'Restart',stop:'Stop',sent:'Done',
      forbidden:'Open the panel from Telegram (the button in the private chat with the bot).',confirmStop:'Interrupt the session\'s current work',confirmRestart:'Restart the session',
      states:{proposed:'📝',assigned:'📋',in_progress:'⚙️',waiting_owner:'⏳',blocked:'🟥',done:'✅',cancelled:'✖️'}},
}
let L = T.ru
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const hhmm = (ms, day) => new Date(ms).toLocaleString(L === T.en ? 'en-GB' : 'ru-RU', Object.assign({hour:'2-digit', minute:'2-digit', hour12:false}, day ? {weekday:'short'} : {}))
const api = (path, body) => fetch(path, {method: body ? 'POST' : 'GET', headers: {'x-telegram-init-data': tg ? tg.initData : '', 'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined})
function bar(w, name, day) {
  if (!w) return ''
  const c = w.pct >= 90 ? '#d33' : w.pct >= 70 ? '#e90' : '#2c3'
  const reset = w.resets_at ? ' · ' + hhmm(Date.parse(w.resets_at), day) : ''
  return '<div class="row"><span class="grow">' + name + '</span><b>' + Math.round(w.pct) + '%</b><span class="hint">' + reset + '</span></div><div class="bar"><i style="width:' + Math.min(100, w.pct) + '%;background:' + c + '"></i></div>'
}
async function act(path, topic, question) {
  const go = () => api(path, {topic}).then(r => r.json()).then(() => { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success'); load() })
  if (tg && tg.showConfirm) tg.showConfirm(question + ' ' + topic + '?', ok => ok && go()); else if (confirm(question + ' ' + topic + '?')) go()
}
async function load() {
  try {
    const r = await api('/api/state')
    if (r.status === 401) { document.getElementById('err').textContent = L.forbidden; return }
    const s = await r.json()
    L = T[s.lang] || T.ru
    document.getElementById('err').textContent = ''
    const card = (title, l) => l ? '<div class="card"><b>' + title + '</b>' + bar(l.five_hour, L.five) + bar(l.week, L.week, true) + (l.as_of ? '<div class="hint">' + L.asof + ' ' + hhmm(Date.parse(l.as_of)) + '</div>' : '') + '</div>' : ''
    document.getElementById('limits').innerHTML = card(L.limits, s.limits) + card(L.codex, s.codex)
    document.getElementById('topics').innerHTML = s.topics.map(tp => {
      const up = tp.connected_since !== null
      const tasks = tp.tasks.length ? tp.tasks.map(x => '<div class="task"><div class="title">' + (L.states[x.state] || '') + ' #' + x.id + ' ' + esc(x.title) + '</div><div class="hint ' + (x.report_age_min > 120 && x.state !== 'done' ? 'old' : '') + '">' + esc(x.summary || '') + ' · ' + x.report_age_min + ' ' + L.min + '</div></div>').join('') : '<div class="hint">' + L.noTasks + '</div>'
      return '<div class="card"><div class="row"><span class="dot ' + (up ? 'up' : 'down') + '"></span><span class="grow title">' + esc(tp.title) + '</span>' +
        (up ? '<button class="ghost" data-a="stop" data-t="' + esc(tp.name) + '">' + L.stop + '</button> ' : '') + '<button data-a="restart" data-t="' + esc(tp.name) + '">' + L.restart + '</button></div>' +
        '<div class="hint">' + (up ? L.up + ' · ' + (tp.busy ? L.busy : L.idle) : L.down) + (tp.pending ? ' · ' + L.pending + ': ' + tp.pending : '') + '</div>' + tasks + '</div>'
    }).join('')
  } catch (e) { document.getElementById('err').textContent = String(e) }
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return
  b.dataset.a === 'stop' ? act('/api/stop', b.dataset.t, L.confirmStop) : act('/api/restart', b.dataset.t, L.confirmRestart)
})
load(); setInterval(load, 10000)
</script></body></html>`
// === GRACE END_BLOCK: broker_panel ============================================
