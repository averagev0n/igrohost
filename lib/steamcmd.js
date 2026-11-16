// SteamCMD: официальная консольная программа Valve, которой ставятся выделенные серверы.
// Все пять игр, кроме Terraria, скачиваются ею без входа в аккаунт (login anonymous).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { download, unzip } = require('./fetchfile');
const { killTree } = require('./util');

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

const STAGES = { downloading: 'Скачивание', verifying: 'Проверка файлов', preallocating: 'Подготовка места', committing: 'Сохранение', reconfiguring: 'Подготовка' };

/** « Update state (0x61) downloading, progress: 12.34 (123 / 456)» → { stage, pct }. */
function parseProgress(line) {
  const m = /Update state \(0x[0-9a-f]+\) ([a-z ]+), progress: ([\d.]+) \((\d+) \/ (\d+)\)/i.exec(line);
  if (!m) return null;
  const key = m[1].trim().split(' ')[0].toLowerCase();
  return { stage: STAGES[key] || 'Установка', pct: Math.min(100, Number(m[2])), done: Number(m[3]), total: Number(m[4]) };
}

/** Понятная причина по строке ошибки SteamCMD. */
function explainError(out) {
  if (/No subscription/i.test(out)) return 'Steam не отдаёт этот сервер без входа в аккаунт';
  if (/Not enough disk space|0x202\b/i.test(out)) return 'Не хватает места на диске';
  if (/No connection|Timeout|0x402\b|0x602\b/i.test(out)) return 'Нет связи со Steam — проверьте интернет и попробуйте ещё раз';
  if (/Missing file permissions|0x212\b/i.test(out)) return 'Нет доступа к папке сервера — возможно, сервер ещё запущен';
  const m = /ERROR! (.+)/.exec(out);
  return m ? 'SteamCMD: ' + m[1].trim() : 'SteamCMD завершился с ошибкой';
}

/**
 * Ошибки, после которых стоит просто запустить SteamCMD ещё раз.
 * «Missing configuration» SteamCMD выдаёт при самом первом запуске, пока обновляет сам себя.
 */
function isTransient(out) {
  return /Missing configuration|Timeout|No connection|state is 0x6\b|0x602\b|0x402\b|0x6\)/i.test(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureSteamCmd(steamDir, { fetchFn, onProgress } = {}) {
  const exe = path.join(steamDir, 'steamcmd.exe');
  if (fs.existsSync(exe)) return exe;
  if (process.platform !== 'win32') throw new Error('Автоустановка SteamCMD пока есть только для Windows');
  const zip = path.join(steamDir, 'steamcmd.zip');
  await download(STEAMCMD_URL, zip, { fetchFn, onProgress });
  await unzip(zip, steamDir);
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(exe)) throw new Error('SteamCMD не распаковался');
  return exe;
}

/**
 * Поставить или обновить сервер. Возвращает { promise, cancel }.
 * Первый запуск SteamCMD обновляет сам себя и иногда выходит раньше времени — тогда пробуем ещё раз.
 */
function appUpdate({ exe, installDir, appId, onProgress, onLine, validate = false }) {
  let proc = null;
  let cancelled = false;
  const once = () =>
    new Promise((resolve, reject) => {
      fs.mkdirSync(installDir, { recursive: true });
      const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId)];
      if (validate) args.push('validate');
      args.push('+quit');
      proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
      let out = '';
      let buf = '';
      const feed = (d) => {
        buf += d;
        const parts = buf.split(/\r?\n|\r/);
        buf = parts.pop();
        for (const raw of parts) {
          const line = raw.replace(ANSI_RE, '').trim();
          if (!line) continue;
          out = (out + '\n' + line).slice(-8000);
          const p = parseProgress(line);
          if (p && onProgress) onProgress(p);
          else if (onLine) onLine(line);
        }
      };
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', feed);
      proc.stderr.on('data', feed);
      proc.on('error', (e) => reject(new Error('Не удалось запустить SteamCMD: ' + e.message)));
      proc.on('close', () => resolve(out));
    });

  const promise = (async () => {
    let out = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(3000);
      out = await once();
      if (cancelled) throw new Error('Установка отменена');
      if (/Success! App '\d+' (fully installed|already up to date)/i.test(out)) return;
      if (/ERROR!/.test(out) && !isTransient(out)) break;
    }
    throw new Error(explainError(out));
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      if (proc) killTree(proc.pid);
    },
  };
}

module.exports = { ensureSteamCmd, appUpdate, parseProgress, explainError, isTransient };
