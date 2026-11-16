// Мелкие общие функции.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Текст из формы: без управляющих символов и кавычек (кавычки ломают аргументы запуска). */
const cleanText = (v, max = 200) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f"]/g, ' ')
    .trim()
    .slice(0, max);

/** Имя, годное для файла или папки. */
const fileSafe = (v, fallback = 'world') => cleanText(v, 60).replace(/[\\/:*?<>|]/g, '').replace(/\.+$/, '').trim() || fallback;

function dirSize(dir) {
  let total = 0;
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    } catch {
      /* файл исчез */
    }
  }
  return total;
}

/** Найти файл по имени не глубже depth уровней. */
function findFile(dir, name, depth = 3) {
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = list.find((e) => !e.isDirectory() && e.name.toLowerCase() === name.toLowerCase());
  if (hit) return path.join(dir, hit.name);
  if (depth <= 0) return null;
  for (const e of list) {
    if (!e.isDirectory()) continue;
    const r = findFile(path.join(dir, e.name), name, depth - 1);
    if (r) return r;
  }
  return null;
}

/** Перенести содержимое папки src в dst (поверх существующего). */
function moveInto(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.statSync(from).isDirectory()) {
      fs.cpSync(from, to, { recursive: true, force: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/** Запустить программу и дождаться конца. Возвращает { code, out }. */
function run(cmd, args, { maxOut = 20000, ...opts } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '';
    const add = (d) => {
      out += d;
      if (out.length > maxOut) out = out.slice(-maxOut);
    };
    if (p.stdout) p.stdout.on('data', add);
    if (p.stderr) p.stderr.on('data', add);
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** Завершить процесс вместе с дочерними. */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* уже завершился */
    }
  }
}

/** Системный tar: в Windows это bsdtar, он умеет и zip. */
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

module.exports = { sleep, cleanText, fileSafe, dirSize, findFile, moveInto, run, killTree, TAR };
