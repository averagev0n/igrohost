// Discord-бот с командами /status, /on, /off, /restart, /backup.
// Подключается к шлюзу Discord по WebSocket и слушает только команды со слешем —
// для них не нужны особые права на чтение сообщений. Регистрирует команды сам; по умолчанию
// они доступны только тем, кто может управлять сервером Discord (право «Управлять сервером»).
const API = 'https://discord.com/api/v10';
const TOKEN_RE = /^[\w-]{20,40}\.[\w-]{4,10}\.[\w-]{20,60}$/;
const MANAGE_GUILD = String(1 << 5);

const SERVER_OPT = [{ type: 4, name: 'server', name_localizations: { ru: 'номер' }, description: 'Номер сервера из /status (не нужен, если сервер один)', required: false, min_value: 1, max_value: 99 }];
const COMMANDS = [
  { name: 'status', description: 'Что с серверами' },
  { name: 'on', description: 'Запустить сервер', options: SERVER_OPT },
  { name: 'off', description: 'Остановить сервер', options: SERVER_OPT },
  { name: 'restart', description: 'Перезапустить сервер', options: SERVER_OPT },
  { name: 'backup', description: 'Сделать копию мира', options: SERVER_OPT },
].map((c) => ({ ...c, default_member_permissions: MANAGE_GUILD, dm_permission: false }));

/** Команда со слешем → текст, как в Telegram: «/on 2». */
function interactionText(data) {
  const n = ((data && data.options) || []).find((o) => o.name === 'server');
  return `/${data.name}${n ? ' ' + n.value : ''}`;
}

function createDiscordBot({ fetchFn = fetch, WS = globalThis.WebSocket, onCommand, onState = () => {}, log = () => {} }) {
  let token = '';
  let ws = null;
  let beat = null;
  let seq = null;
  let stopped = true;
  let appId = null;
  let retry = null;

  async function rest(method, path, body, tok = token) {
    const res = await fetchFn(API + path, {
      method,
      headers: { Authorization: `Bot ${tok}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/averagev0n/igrohost, 0.3)' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw Object.assign(new Error('Discord не принял токен бота — скопируйте его ещё раз'), { fatal: true });
    if (!res.ok) throw new Error(`Discord ответил ошибкой ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  /** Проверить токен и вернуть имя бота и ссылку, по которой его добавляют на сервер Discord. */
  async function check(tok) {
    if (!TOKEN_RE.test(tok)) throw new Error('Это не похоже на токен бота Discord');
    const me = await rest('GET', '/users/@me', null, tok);
    const appInfo = await rest('GET', '/oauth2/applications/@me', null, tok);
    return { name: me.username, appId: appInfo.id, invite: `https://discord.com/oauth2/authorize?client_id=${appInfo.id}&scope=bot%20applications.commands&permissions=0` };
  }

  async function reply(i, content) {
    await rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } } }, token).catch(() => {});
  }

  async function onInteraction(i) {
    if (i.type !== 2 || !i.data) return;
    // Ответить нужно за 3 секунды: долгие команды (копия) сначала получают «думаю…».
    let answered = false;
    const timer = setTimeout(async () => {
      answered = true;
      await rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 5 }, token).catch(() => {});
    }, 2000);
    const out = [];
    try {
      await onCommand(interactionText(i.data), (text) => out.push(text));
    } catch (e) {
      out.push(`Не получилось: ${e.message}`);
    }
    clearTimeout(timer);
    const text = out.join('\n') || 'Готово.';
    if (answered) await rest('PATCH', `/webhooks/${appId}/${i.token}/messages/@original`, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, token).catch(() => {});
    else await reply(i, text);
  }

  function connect() {
    if (stopped || !WS) return;
    ws = new WS('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.s) seq = m.s;
      if (m.op === 10) {
        clearInterval(beat);
        beat = setInterval(() => ws && ws.readyState === 1 && ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'windows', browser: 'igrohost', device: 'igrohost' } } }));
      } else if (m.op === 1) {
        ws.send(JSON.stringify({ op: 1, d: seq }));
      } else if (m.op === 0 && m.t === 'READY') {
        onState({ online: true });
      } else if (m.op === 0 && m.t === 'INTERACTION_CREATE') {
        onInteraction(m.d);
      } else if (m.op === 9 || m.op === 7) {
        ws.close();
      }
    });
    ws.addEventListener('close', (ev) => {
      clearInterval(beat);
      onState({ online: false });
      if (stopped) return;
      // 4004 — неверный токен: дальше пробовать бессмысленно.
      if (ev.code === 4004) {
        stopped = true;
        onState({ online: false, fatal: 'Discord не принял токен бота' });
        return;
      }
      retry = setTimeout(connect, 10000);
    });
    ws.addEventListener('error', () => {});
  }

  return {
    check,
    async start(tok) {
      this.stop();
      token = tok;
      stopped = false;
      const info = await check(tok);
      appId = info.appId;
      await rest('PUT', `/applications/${appId}/commands`, COMMANDS);
      connect();
      return info;
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(beat);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* уже закрыт */
        }
      }
      ws = null;
    },
    _onInteraction: onInteraction,
  };
}

module.exports = { createDiscordBot, interactionText, COMMANDS, TOKEN_RE };
