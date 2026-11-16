// Логика Telegram-бота: привязка чата кодом, команды и тексты уведомлений.
// Сам обмен с Telegram — в telegram.js; здесь только разбор сообщений, чтобы это можно было проверить тестами.
const { parseCommand } = require('./telegram');

const HELP = [
  'Команды:',
  '/status — что с серверами',
  '/on 1 — запустить сервер №1',
  '/off 1 — остановить',
  '/restart 1 — перезапустить',
  '/backup 1 — сделать копию',
  '/cmd 1 say Привет — команда в консоль сервера',
  '',
  'Номер — из /status. Если сервер один, номер можно не писать.',
].join('\n');

const DOT = { running: '🟢', starting: '🟡', stopping: '🟡', installing: '🔵', stopped: '⚪' };
const WORD = { running: 'работает', starting: 'запускается', stopping: 'останавливается', installing: 'устанавливается', stopped: 'выключен' };
const EVENTS = { start: true, stop: true, crash: true, players: true, backup: false };

function uptime(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'меньше минуты';
  const h = Math.floor(min / 60);
  return h ? `${h} ч ${min % 60} мин` : `${min} мин`;
}

function statusText(list) {
  if (!list.length) return 'Серверов пока нет. Создайте первый в панели.';
  return list
    .map((s, i) => {
      let line = `${i + 1}. ${DOT[s.state] || '⚪'} ${s.gameTitle} «${s.name}» — ${WORD[s.state] || s.state}`;
      if (s.state === 'running' && s.startedAt) line += ` ${uptime(Date.now() - s.startedAt)}`;
      if (s.state === 'running' && s.players && s.players.length) line += `, игроки: ${s.players.join(', ')}`;
      return line;
    })
    .join('\n');
}

/** «2 say привет» → { server, rest } или текст ошибки. */
function pickServer(list, arg) {
  const m = /^(\d+)(?:\s+([\s\S]*))?$/.exec(arg);
  if (m) {
    const s = list[Number(m[1]) - 1];
    return s ? { server: s, rest: (m[2] || '').trim() } : { error: `Сервера №${m[1]} нет. Список: /status` };
  }
  if (list.length === 1) return { server: list[0], rest: arg };
  if (!list.length) return { error: 'Серверов пока нет.' };
  return { error: 'Укажите номер сервера, например /on 1. Список: /status' };
}

/**
 * cfg() → { chatId, control, events }, link(chatId, chatName) — привязать чат,
 * code() → действующий код привязки или null, actions — действия над серверами.
 */
function createBot({ cfg, link, code, send, actions }) {
  async function onMessage(m) {
    const cmd = parseCommand(m.text);
    const chatId = m.chat && m.chat.id;
    if (!cmd || !chatId) return;
    const c = cfg();
    if (!c.chatId) {
      const cur = code();
      if (cmd.cmd === 'start' && cur && cmd.arg === cur) {
        link(chatId, (m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || '').slice(0, 60));
        await send(chatId, `Готово: панель привязана к этому чату.\n\n${HELP}`);
      }
      return; // до привязки отвечаем только на правильный код
    }
    if (chatId !== c.chatId) return; // чужие чаты молча пропускаем
    if (cmd.cmd === 'start' || cmd.cmd === 'help') return send(chatId, HELP);
    const list = actions.list();
    if (cmd.cmd === 'status') return send(chatId, statusText(list));
    if (!['on', 'off', 'restart', 'backup', 'cmd'].includes(cmd.cmd)) return send(chatId, HELP);
    if (!c.control) return send(chatId, 'Управление из Telegram выключено. Включить: панель → «Telegram-бот».');
    const p = pickServer(list, cmd.arg);
    if (p.error) return send(chatId, p.error);
    const s = p.server;
    const title = `${s.gameTitle} «${s.name}»`;
    try {
      if (cmd.cmd === 'on') {
        await actions.start(s.id);
        return send(chatId, `Запускаю ${title}…`);
      }
      if (cmd.cmd === 'off') {
        await actions.stop(s.id);
        return send(chatId, `Останавливаю ${title}…`);
      }
      if (cmd.cmd === 'restart') {
        await actions.restart(s.id);
        return send(chatId, `Перезапускаю ${title}…`);
      }
      if (cmd.cmd === 'backup') {
        await send(chatId, `Делаю копию ${title}…`);
        await actions.backup(s.id);
        return send(chatId, 'Копия готова.');
      }
      if (!p.rest) return send(chatId, 'Напишите команду после номера: /cmd 1 say Всем привет');
      const reply = await actions.command(s.id, p.rest);
      return send(chatId, reply ? String(reply).slice(0, 3500) : 'Отправлено.');
    } catch (e) {
      return send(chatId, `Не получилось: ${e.message}`);
    }
  }
  return { onMessage };
}

module.exports = { createBot, statusText, pickServer, HELP, EVENTS };
