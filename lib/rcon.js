// Каналы управления сервером, у которого нет обычной консоли:
//  • Telnet (7 Days to Die) — TCP, построчно;
//  • Source RCON (CS2) — TCP;
//  • WebRCON (Rust) — WebSocket;
//  • REST API (Palworld) — HTTP.
// У всех одинаковый вид: { send(команда) → Promise<ответ>, close() }.
const net = require('net');

// ---- Source RCON ----

const T_AUTH = 3;
const T_EXEC = 2;
const T_AUTH_RESPONSE = 2;

function encodePacket(id, type, body) {
  const b = Buffer.from(String(body), 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf; // два завершающих нуля уже есть
}

/** Вынуть из буфера целые пакеты. Возвращает { packets, rest }. */
function decodePackets(buf) {
  const packets = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (size < 10 || size > 1 << 20) throw new Error('Неверный ответ RCON');
    if (buf.length - off < 4 + size) break;
    packets.push({
      id: buf.readInt32LE(off + 4),
      type: buf.readInt32LE(off + 8),
      body: buf.toString('utf8', off + 12, off + 4 + size - 2),
    });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}

function sourceRcon({ host = '127.0.0.1', port, password, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let nextId = 10;
    let authed = false;
    const waiting = new Map(); // id → { resolve, timer }
    const fail = (e) => {
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(e);
      }
      waiting.clear();
      if (!authed) reject(e);
    };
    const t = setTimeout(() => {
      sock.destroy();
      fail(new Error('Сервер не отвечает по RCON'));
    }, timeout);
    sock.on('connect', () => sock.write(encodePacket(1, T_AUTH, password)));
    sock.on('error', () => {
      clearTimeout(t);
      fail(new Error('Нет связи с сервером по RCON'));
    });
    sock.on('close', () => fail(new Error('Связь по RCON закрыта')));
    sock.on('data', (d) => {
      let res;
      try {
        res = decodePackets(Buffer.concat([buf, d]));
      } catch (e) {
        sock.destroy();
        return fail(e);
      }
      buf = res.rest;
      for (const p of res.packets) {
        if (!authed) {
          if (p.type !== T_AUTH_RESPONSE) continue; // перед ответом на вход приходит пустой пакет
          clearTimeout(t);
          if (p.id === -1) {
            sock.destroy();
            return reject(new Error('Сервер не принял пароль RCON'));
          }
          authed = true;
          resolve({
            send(cmd) {
              return new Promise((res2, rej2) => {
                const id = nextId++;
                const timer = setTimeout(() => {
                  waiting.delete(id);
                  res2(''); // команды вроде quit ответа не дают
                }, 4000);
                waiting.set(id, { resolve: res2, reject: rej2, timer });
                sock.write(encodePacket(id, T_EXEC, cmd));
              });
            },
            close: () => sock.destroy(),
          });
          continue;
        }
        const w = waiting.get(p.id);
        if (w) {
          clearTimeout(w.timer);
          waiting.delete(p.id);
          w.resolve(p.body.trim());
        }
      }
    });
  });
}

// ---- Rust WebRCON ----

function webRcon({ host = '127.0.0.1', port, password, timeout = 5000, WS = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    if (!WS) return reject(new Error('Нужен Node.js 22 или новее'));
    const ws = new WS(`ws://${host}:${port}/${encodeURIComponent(password)}`);
    let nextId = 1000;
    let open = false;
    const waiting = new Map();
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* не открылся */
      }
      reject(new Error('Сервер не отвечает по RCON'));
    }, timeout);
    ws.addEventListener('open', () => {
      open = true;
      clearTimeout(t);
      resolve({
        send(cmd) {
          return new Promise((res) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              waiting.delete(id);
              res('');
            }, 4000);
            waiting.set(id, { resolve: res, timer });
            ws.send(JSON.stringify({ Identifier: id, Message: String(cmd), Name: 'igrohost' }));
          });
        },
        close: () => ws.close(),
      });
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const w = waiting.get(m.Identifier);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(m.Identifier);
      w.resolve(String(m.Message || '').trim());
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      if (!open) reject(new Error('Нет связи с сервером по RCON'));
    });
  });
}

// ---- Palworld REST API ----

/** «announce Привет» → запрос к REST API. Возвращает null для неизвестной команды. */
function palRequest(text) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(String(text).trim());
  if (!m) return null;
  const arg = m[2].trim();
  switch (m[1].toLowerCase()) {
    case 'info':
      return { method: 'GET', path: 'info' };
    case 'players':
      return { method: 'GET', path: 'players' };
    case 'settings':
      return { method: 'GET', path: 'settings' };
    case 'save':
      return { method: 'POST', path: 'save' };
    case 'announce':
    case 'say':
      return arg ? { method: 'POST', path: 'announce', body: { message: arg } } : null;
    case 'kick':
      return arg ? { method: 'POST', path: 'kick', body: { userid: arg, message: 'Вас отключил администратор' } } : null;
    case 'ban':
      return arg ? { method: 'POST', path: 'ban', body: { userid: arg, message: 'Вы заблокированы' } } : null;
    case 'unban':
      return arg ? { method: 'POST', path: 'unban', body: { userid: arg } } : null;
    case 'shutdown':
      return { method: 'POST', path: 'shutdown', body: { waittime: Math.max(1, Number(arg) || 1), message: 'Сервер выключается' } };
    case 'stop':
      return { method: 'POST', path: 'stop' };
    default:
      return null;
  }
}

const PAL_HELP = 'Команды: info, players, save, announce <текст>, kick <id>, ban <id>, unban <id>, shutdown [секунд]';

async function palRest({ host = '127.0.0.1', port, password, fetchFn = fetch }) {
  const auth = 'Basic ' + Buffer.from('admin:' + password).toString('base64');
  const call = async (r) => {
    let res;
    try {
      res = await fetchFn(`http://${host}:${port}/v1/api/${r.path}`, {
        method: r.method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: r.body ? JSON.stringify(r.body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('Сервер не отвечает (REST API)');
    }
    if (res.status === 401) throw new Error('Сервер не принял пароль администратора');
    const text = await res.text();
    if (!res.ok) throw new Error(`Сервер ответил ошибкой ${res.status}`);
    return text;
  };
  await call({ method: 'GET', path: 'info' }); // проверка связи
  return {
    async send(cmd) {
      const r = palRequest(cmd);
      if (!r) return PAL_HELP;
      const text = await call(r);
      if (r.path === 'players') {
        try {
          const list = JSON.parse(text).players || [];
          return list.length ? list.map((p) => `${p.name} (уровень ${p.level}, id ${p.userId})`).join('\n') : 'Игроков нет';
        } catch {
          return text;
        }
      }
      return text && text !== 'OK' ? text : 'Готово';
    },
    close() {},
  };
}

// ---- Telnet (7 Days to Die) ----

// Строки журнала, которые telnet повторяет вслед за файлом: «2026-11-16T14:20:00 123.456 INF …».
const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s/;
const IAC_RE = /\xff[\xfb-\xfe][\s\S]|\xff[\s\S]/g;

/** Ответ на команду без строк журнала и служебных байтов telnet. */
function telnetReply(text) {
  return String(text)
    .replace(IAC_RE, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trimEnd())
    .filter((l) => l.trim() && !LOG_LINE_RE.test(l))
    .join('\n');
}

function telnet({ host = '127.0.0.1', port, password = '', timeout = 6000, replyMs = 1500 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setEncoding('utf8');
    let buf = '';
    let ready = false;
    let sentPassword = false;
    let collect = null; // { text } — копим ответ на текущую команду
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('Сервер не отвечает по telnet'));
    }, timeout);
    const link = {
      send(cmd) {
        return new Promise((res) => {
          collect = { text: '' };
          sock.write(String(cmd) + '\r\n');
          setTimeout(() => {
            const out = telnetReply(collect ? collect.text : '');
            collect = null;
            res(out);
          }, replyMs);
        });
      },
      close: () => sock.destroy(),
    };
    sock.on('data', (d) => {
      if (collect) collect.text += d;
      if (ready) return;
      buf += d;
      if (/enter password/i.test(buf) && !sentPassword) {
        if (!password) {
          sock.destroy();
          return reject(new Error('Сервер просит пароль telnet'));
        }
        sentPassword = true;
        buf = '';
        sock.write(password + '\r\n');
        return;
      }
      if (/password incorrect|wrong password/i.test(buf)) {
        sock.destroy();
        return reject(new Error('Сервер не принял пароль telnet'));
      }
      if (/Logon successful|Connected with 7DTD server/i.test(buf)) {
        ready = true;
        clearTimeout(t);
        resolve(link);
      }
    });
    sock.on('error', () => {
      clearTimeout(t);
      if (!ready) reject(new Error('Нет связи с сервером по telnet'));
    });
  });
}

/** Открыть канал по описанию из игры: { type, port, password }. */
function openLink(desc, deps = {}) {
  if (desc.type === 'telnet') return telnet(desc);
  if (desc.type === 'rcon') return sourceRcon(desc);
  if (desc.type === 'webrcon') return webRcon({ ...desc, ...deps });
  if (desc.type === 'palrest') return palRest({ ...desc, ...deps });
  return Promise.reject(new Error('У этой игры нет удалённой консоли'));
}

module.exports = { encodePacket, decodePackets, sourceRcon, webRcon, palRest, palRequest, telnet, telnetReply, openLink, PAL_HELP };
