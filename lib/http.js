// Веб-сервер панели: страница, вызовы API и поток событий (SSE). Два входа:
//  • местный — только этот компьютер (127.0.0.1), по секретному ключу: ключ один раз передаётся
//    в адресе, дальше хранится в cookie;
//  • домашняя сеть (по желанию) — для телефона: только адреса локальной сети, вход по ПИН-коду,
//    после пяти неверных попыток адрес блокируется на 10 минут.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const MAX_JSON = 1 << 20;
const MAX_UPLOAD = 1 << 30;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'";
const LOGIN_FILES = new Set(['login.html', 'login.js', 'fonts.css', 'style.css', 'icon.svg']);
const FAILS_MAX = 5;
const BLOCK_MS = 10 * 60000;
// С телефона нельзя менять сам доступ с телефона и смотреть ПИН-код.
const REMOTE_DENY = /^(remote|app):/;

const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Адрес из домашней сети (или этот же компьютер). */
function isLanAddress(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^(fe80|fc|fd)/i.test(ip);
}

const cookie = (req, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
};

/**
 * remote — доступ из домашней сети: { pin() → строка или null, hasSession(hash), addSession(hash) }.
 */
function createHttp({ app, staticDir, token, remote = null, now = Date.now }) {
  const clients = new Set();
  const fails = new Map(); // ip → { n, until }

  function emit(channel, payload) {
    const msg = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          reject(new Error('Слишком большой запрос'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serveStatic(res, rel) {
    const file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir + path.sep) || !MIME[path.extname(file)]) return json(res, 404, { ok: false, error: 'Не найдено' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { ok: false, error: 'Не найдено' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  /** Вход с телефона по ПИН-коду. */
  async function login(req, res, ip) {
    const f = fails.get(ip);
    if (f && f.until > now()) return json(res, 429, { ok: false, error: `Слишком много попыток. Попробуйте через ${Math.ceil((f.until - now()) / 60000)} мин.` });
    let pin = '';
    try {
      pin = String(JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}').pin || '').trim();
    } catch {
      /* пусто */
    }
    const want = remote.pin();
    if (!want || !same(pin, want)) {
      // Счётчик сбрасывается только после окончания блокировки, а не после каждой ошибки.
      const n = (f && !(f.until && f.until <= now()) ? f.n : 0) + 1;
      fails.set(ip, { n: n >= FAILS_MAX ? 0 : n, until: n >= FAILS_MAX ? now() + BLOCK_MS : 0 });
      return json(res, 403, { ok: false, error: n >= FAILS_MAX ? 'Слишком много попыток. Попробуйте через 10 мин.' : 'Неверный ПИН-код' });
    }
    fails.delete(ip);
    const session = crypto.randomBytes(32).toString('hex');
    remote.addSession(sha(session));
    return json(res, 200, { ok: true }, { 'Set-Cookie': `igrphone=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000` });
  }

  async function handle(req, res, mode) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { ok: false, error: 'Запрос с чужой страницы' });

    if (mode === 'local') {
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { ok: false, error: 'Панель доступна только с этого компьютера' });
      // Вход по ключу из адреса: ставим cookie и убираем ключ из адресной строки.
      const t = url.searchParams.get('t');
      if (url.pathname === '/' && t) {
        if (!same(t, token)) return json(res, 403, { ok: false, error: 'Неверный ключ' });
        res.writeHead(302, { 'Set-Cookie': `igrohost=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
        return res.end();
      }
      if (!same(cookie(req, 'igrohost'), token)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Откройте панель по ссылке из окна программы (в ней есть ключ доступа).');
      }
    } else {
      const ip = req.socket.remoteAddress;
      if (!remote || !remote.pin() || !isLanAddress(ip)) return json(res, 403, { ok: false, error: 'Доступ только из домашней сети' });
      if (url.pathname === '/api/login' && req.method === 'POST') return login(req, res, ip);
      const s = cookie(req, 'igrphone');
      if (!s || !remote.hasSession(sha(s))) {
        const rel = url.pathname.slice(1);
        if (req.method === 'GET' && (LOGIN_FILES.has(rel) || /^fonts\/[\w-]+\.woff2$/.test(rel))) return serveStatic(res, rel);
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          res.writeHead(302, { Location: '/login.html' });
          return res.end();
        }
        return json(res, 401, { ok: false, error: 'Войдите по ПИН-коду' });
      }
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === '/api/call' && req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Нужен JSON' });
      try {
        const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        const method = String(body.method);
        if (mode === 'remote' && REMOTE_DENY.test(method)) throw new Error('Это можно сделать только на компьютере с панелью');
        const data = await app.call(method, body.arg, { remote: mode === 'remote' });
        return json(res, 200, { ok: true, data: data === undefined ? null : data });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message || 'Ошибка' });
      }
    }

    // Скачать журнал сервера (последний запуск).
    if (url.pathname === '/api/log' && req.method === 'GET') {
      let text;
      try {
        text = app.logText(url.searchParams.get('id'));
      } catch (e) {
        return json(res, 404, { ok: false, error: e.message });
      }
      // Метка UTF-8 в начале: без неё Блокнот покажет русские строки кракозябрами.
      const body = Buffer.from('﻿' + text, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Content-Disposition': 'attachment; filename="server-log.txt"', 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    // Скачать резервную копию мира.
    if (url.pathname === '/api/backup' && req.method === 'GET') {
      let file;
      try {
        file = app.backupFile(url.searchParams.get('id'), url.searchParams.get('name'));
      } catch (e) {
        return json(res, 404, { ok: false, error: e.message });
      }
      const st = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const tmp = path.join(os.tmpdir(), 'igrohost-upload-' + crypto.randomBytes(6).toString('hex'));
      try {
        if (Number(req.headers['content-length']) > MAX_UPLOAD) throw new Error('Файл больше 1 ГБ');
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          let size = 0;
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_UPLOAD) req.destroy(new Error('Файл больше 1 ГБ'));
          });
          req.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          req.pipe(out);
        });
        const data = await app.upload({ id: url.searchParams.get('id'), folder: url.searchParams.get('folder'), name: url.searchParams.get('name'), filePath: tmp });
        return json(res, 200, { ok: true, data });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message || 'Ошибка' });
      } finally {
        fs.rm(tmp, { force: true }, () => {});
      }
    }

    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Метод не поддерживается' });
    return serveStatic(res, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
  }

  const make = (mode) =>
    http.createServer((req, res) => {
      handle(req, res, mode).catch(() => {
        if (!res.headersSent) json(res, 500, { ok: false, error: 'Внутренняя ошибка' });
      });
    });
  const server = make('local');
  let remoteServer = null;

  const listenOn = (srv, port, host) =>
    new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.removeListener('error', reject);
        resolve(srv.address().port);
      });
    });

  return {
    emit,
    listen: (port) => listenOn(server, port, '127.0.0.1'),
    /** Открыть вход для телефона на всех сетевых адресах. */
    async listenRemote(port) {
      if (remoteServer) return remoteServer.address().port;
      const srv = make('remote');
      try {
        const p = await listenOn(srv, port, '0.0.0.0');
        remoteServer = srv;
        return p;
      } catch (e) {
        throw new Error(e.code === 'EADDRINUSE' ? `Порт ${port} занят другой программой — выберите другой` : 'Не удалось открыть доступ с телефона: ' + e.message);
      }
    },
    closeRemote() {
      if (!remoteServer) return;
      remoteServer.closeAllConnections && remoteServer.closeAllConnections();
      remoteServer.close();
      remoteServer = null;
    },
    remotePort: () => (remoteServer ? remoteServer.address().port : null),
    close: () => {
      for (const res of clients) res.end();
      server.close();
      if (remoteServer) remoteServer.close();
    },
  };
}

module.exports = { createHttp, isLanAddress };
