// Веб-сервер панели: страница, вызовы API и поток событий (SSE).
// Слушает только этот компьютер (127.0.0.1) и пускает только по секретному ключу:
// ключ один раз передаётся в адресе, дальше хранится в cookie.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const MAX_JSON = 1 << 20;
const MAX_UPLOAD = 1 << 30;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'";

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createHttp({ app, staticDir, token }) {
  const clients = new Set();

  function emit(channel, payload) {
    const msg = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function authed(req) {
    const m = /(?:^|;\s*)igrohost=([a-f0-9]+)/.exec(req.headers.cookie || '');
    return !!m && same(m[1], token);
  }

  /** Запросы принимаем только на локальный адрес и только со своей же страницы. */
  function localOnly(req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://${req.headers.host}`;
  }

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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!localOnly(req)) return json(res, 403, { ok: false, error: 'Панель доступна только с этого компьютера' });

    // Вход по ключу из адреса: ставим cookie и убираем ключ из адресной строки.
    const t = url.searchParams.get('t');
    if (url.pathname === '/' && t) {
      if (!same(t, token)) return json(res, 403, { ok: false, error: 'Неверный ключ' });
      res.writeHead(302, { 'Set-Cookie': `igrohost=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
      return res.end();
    }
    if (!authed(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Откройте панель по ссылке из окна программы (в ней есть ключ доступа).');
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
        const data = await app.call(String(body.method), body.arg);
        return json(res, 200, { ok: true, data: data === undefined ? null : data });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message || 'Ошибка' });
      }
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
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(staticDir, rel);
    if (!file.startsWith(staticDir + path.sep) || !MIME[path.extname(file)]) return json(res, 404, { ok: false, error: 'Не найдено' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { ok: false, error: 'Не найдено' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'Внутренняя ошибка' });
    });
  });

  return {
    emit,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      }),
    close: () => {
      for (const res of clients) res.end();
      server.close();
    },
  };
}

module.exports = { createHttp };
