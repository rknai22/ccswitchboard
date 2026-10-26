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
  session_down: {
    en: 'topic {name}: the session is down — restarting it',
    ru: 'тема {name}: сессия упала — перезапускаю',
  },
  session_up: { en: 'topic {name}: the session is back up', ru: 'тема {name}: сессия поднялась' },
  orca_down: {
    en: 'Orca is not answering on the session machine — sessions are not restarted until it does.',
    ru: 'Orca не отвечает на машине сессий — сессии не перезапускаю, пока не ответит.',
  },
} satisfies Record<string, Record<Lang, string>>

export type StringKey = keyof typeof STRINGS

export function t(lang: Lang, key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[key][lang].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
// === GRACE END_BLOCK: broker_strings ==========================================
