// === GRACE START_BLOCK: broker_strings ========================================
// MODULE_CONTRACT:
//   IN:  lang from config ("ru" | "en"), a string key, optional {vars}.
//   OUT: the text the owner sees in Telegram or the setup wizard.
//   INV: one table for every owner-facing text — both languages side by side,
//        so a new string cannot ship in one language only (the type requires
//        both). Protocol-level errors for the shim stay English constants.

import type { Lang } from './config.ts'

const STRINGS = {
  general_title: { en: 'General', ru: 'Общий' },
  claim_question: { en: 'Is this the ccswitchboard group?', ru: 'Это группа ccswitchboard?' },
  claim_button: { en: "Yes, it's ours", ru: 'Да, наша' },
  claim_done: {
    en: 'Done: this group is connected to ccswitchboard, owner — {owner}.',
    ru: 'Готово: группа подключена к ccswitchboard, владелец — {owner}.',
  },
  claim_expired: {
    en: 'The button expired. Run the setup again to get a new one.',
    ru: 'Кнопка истекла. Запусти мастер ещё раз, придёт новая.',
  },
  callback_expired: { en: 'Expired.', ru: 'Истекло.' },
  callback_done: { en: 'Done.', ru: 'Готово.' },
  reset_question: { en: 'Reset the ccswitchboard setup?', ru: 'Сбросить настройку ccswitchboard?' },
  reset_button: { en: 'Reset', ru: 'Сбросить' },
  reset_done: {
    en: 'ccswitchboard setup has been reset. Folders and sessions are kept; run /ccswitchboard:setup to connect again.',
    ru: 'Настройка ccswitchboard сброшена. Папки и сессии остались; заново — /ccswitchboard:setup.',
  },
  reset_expired: { en: 'Reset button expired — nothing changed.', ru: 'Кнопка сброса истекла — ничего не изменилось.' },
  conflict_409: {
    en: 'Someone else is polling this bot — check that a second instance is not running.',
    ru: 'Бота опрашивает кто-то ещё — проверь, не запущен ли второй экземпляр.',
  },
  token_rejected: { en: 'Telegram did not recognize the token.', ru: 'Telegram не узнал токен.' },
  telegram_unreachable: {
    en: 'Could not reach Telegram to check the token: {err}',
    ru: 'Не удалось связаться с Telegram для проверки токена: {err}',
  },
  already_locked: {
    en: 'Already configured; to reset — /ccswitchboard:reset.',
    ru: 'Уже настроено, сброс — /ccswitchboard:reset.',
  },
  reset_not_configured: {
    en: 'Setup is not finished, so there is nothing to reset: a new token via /ccswitchboard:setup replaces the old one.',
    ru: 'Настройка не закончена, сбрасывать нечего: новый токен через /ccswitchboard:setup заменит прежний.',
  },
  hint_add_bot: {
    en: 'Add the bot to a group with topics enabled and make it an admin with the "Manage topics" and "Pin messages" rights.',
    ru: 'Добавь бота в группу с включёнными темами и сделай админом с правами «Управление темами» и «Закрепление сообщений».',
  },
  hint_no_forum: { en: 'Turn on topics in the group settings.', ru: 'Включи темы в настройках группы.' },
  hint_rights: {
    en: 'Give the bot the "Manage topics" and "Pin messages" admin rights.',
    ru: 'Дай боту права админа «Управление темами» и «Закрепление сообщений».',
  },
  hint_press_button: {
    en: 'Press "Yes, it\'s ours" in the group.',
    ru: 'Нажми «Да, наша» в группе.',
  },
  hint_button_expired: {
    en: 'The button expired. Take the bot\'s admin rights away and grant them again (or send the token again) — a new button will come.',
    ru: 'Кнопка истекла. Сними с бота права админа и выдай снова (или передай токен ещё раз) — придёт новая кнопка.',
  },
  // ---- pinned limits message and the morning digest (pin.ts, digest.ts) ----
  limits_title: { en: 'Claude limits', ru: 'Лимиты Claude' },
  limits_five_hour: { en: '5 hours', ru: '5 часов' },
  limits_week: { en: 'Week', ru: 'Неделя' },
  limits_pct: { en: '{pct}%', ru: '{pct} %' },
  limits_reset: { en: 'resets {at}', ru: 'сброс {at}' },
  limits_no_data: { en: 'no data', ru: 'нет данных' },
  limits_as_of: { en: 'Data as of {at}', ru: 'Данные на {at}' },
  limits_stale: { en: 'no session has run since', ru: 'с тех пор сессии не работали' },
  limits_short: { en: 'Limits: 5 h {five} · week {week}', ru: 'Лимиты: 5 ч {five} · неделя {week}' },
  limits_short_as_of: { en: '(data as of {at})', ru: '(данные на {at})' },
  digest_title: { en: 'Digest at {at}', ru: 'Сводка на {at}' },
  digest_no_topics: { en: 'No topics yet.', ru: 'Тем пока нет.' },
  digest_no_status: { en: 'no status', ru: 'нет статуса' },
  digest_waiting: { en: 'waiting for your "yes": {item}', ru: 'ждёт твоего «да»: {item}' },
  digest_more: { en: '…and {n} more', ru: '…и ещё {n}' },
  // ---- topics and sessions (topics.ts, sessions.ts) ----
  forward_prefix: {
    en: '📨 from the owner via General: {text}',
    ru: '📨 от владельца через «Общий»: {text}',
  },
  topic_deleted: {
    en: 'Topic {name} was deleted in Telegram — removed it from the registry. Its folder {cwd} is kept.',
    ru: 'Тема {name} удалена в Telegram — убрал её из реестра. Папка {cwd} осталась.',
  },
  session_down: { en: 'topic {name}: the session is down', ru: 'тема {name}: сессия упала' },
  session_up: { en: 'topic {name}: the session is back up', ru: 'тема {name}: сессия поднялась' },
  orca_down: {
    en: 'Orca is not answering on the session machine — sessions are not restarted until it does.',
    ru: 'Orca не отвечает на машине сессий — сессии не перезапускаю, пока не ответит.',
  },
  session_blocked_alive: {
    en: 'topic {name}: the session is not connected, but its Claude process is still running in a terminal I cannot identify as mine ({cwd}). Not starting a second one — close the extra terminal in Orca and I will start it again.',
    ru: 'тема {name}: сессия не на связи, но её процесс Claude ещё жив в терминале, который я не могу опознать как свой ({cwd}). Вторую не запускаю — закрой лишний терминал в Orca, дальше подниму сам.',
  },
  session_blocked_unknown: {
    en: 'topic {name}: the session is not connected; I cannot count processes on the session machine, and {cwd} has a terminal I cannot identify as mine (it may be a restored copy of the session). Not starting a second one — once that folder has no extra terminals in Orca, I will start it again.',
    ru: 'тема {name}: сессия не на связи; процессы на машине сессий проверить не могу, а в {cwd} открыт терминал, который я не могу опознать как свой (может быть восстановленной копией сессии). Вторую не запускаю — как только в этой папке в Orca не останется лишних терминалов, подниму сам.',
  },
  session_alive_unreachable: {
    en: 'topic {name}: the session is alive but cannot reach the broker (network from the session machine to the broker?). Not restarting it, so its work and conversation are kept.',
    ru: 'тема {name}: сессия жива, но не на связи с брокером (сеть машины сессий → брокер?). Не перезапускаю, чтобы не потерять её работу и разговор.',
  },
  heal_failed_ask: {
    en: 'topic {name}: the session is alive but its plugin is down, and reconnecting it did not help (3 tries). Restart the session? It resumes the same conversation.',
    ru: 'тема {name}: сессия жива, но её плагин упал, и переподключить не вышло (3 попытки). Перезапустить сессию? Разговор продолжится тот же.',
  },
  restart_confirm: {
    en: 'Restart the session of {name}? Its terminal is closed and Claude starts again with the same conversation.',
    ru: 'Перезапустить сессию {name}? Её терминал закроется, Claude запустится заново с тем же разговором.',
  },
  restart_starting: { en: 'No session is running — starting one.', ru: 'Сессия не запущена — запускаю.' },
  restart_unclear: {
    en: 'Cannot tell which terminal is this session (several, or none recognised) — not touching anything. Close the extra ones in Orca.',
    ru: 'Не могу понять, какой терминал — эта сессия (их несколько или ни одного опознанного), ничего не трогаю. Закрой лишние в Orca.',
  },
  status_up: { en: '🟢 session connected since {since}', ru: '🟢 сессия на связи с {since}' },
  status_down: { en: '🔴 session not connected', ru: '🔴 сессия не на связи' },
  status_busy: { en: 'working on a message', ru: 'работает над сообщением' },
  status_idle: { en: 'idle', ru: 'свободна' },
  status_pending: { en: 'waiting for delivery: {n}', ru: 'ждут доставки: {n}' },
  status_last_reply: { en: 'last reply: {at}', ru: 'последний ответ: {at}' },
  help: {
    en: '/status — is the session connected, busy, anything waiting\n/restart — restart this topic\'s session (asks first)\n/help — this list\nAnything else goes to the session.',
    ru: '/status — на связи ли сессия, занята ли, ждёт ли что-то\n/restart — перезапустить сессию этой темы (сначала спросит)\n/help — этот список\nВсё остальное уходит сессии.',
  },
  cmd_status: { en: 'session state', ru: 'состояние сессии' },
  cmd_restart: { en: 'restart the session', ru: 'перезапустить сессию' },
  cmd_help: { en: 'commands', ru: 'команды' },
  restart_button: { en: '🔄 Restart {name}', ru: '🔄 Перезапустить {name}' },
  restart_gone: { en: 'That terminal is already gone — nothing to restart.', ru: 'Этого терминала уже нет — перезапускать нечего.' },
  takeover_refused: {
    en: 'topic {name}: another copy of the plugin tried to take the topic (e.g. `claude mcp list` inside the session); the live session kept it.',
    ru: 'тема {name}: другая копия плагина пыталась забрать тему (например, `claude mcp list` внутри сессии); живая сессия её удержала.',
  },
  topic_closed_hint: {
    en: 'This topic is closed — reopen it to continue.',
    ru: 'Тема закрыта — открой её, чтобы продолжить.',
  },
} satisfies Record<string, Record<Lang, string>>

export type StringKey = keyof typeof STRINGS

export function t(lang: Lang, key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[key][lang].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
// === GRACE END_BLOCK: broker_strings ==========================================
