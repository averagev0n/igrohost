// Редактор файлов настроек: только файлы из списка игры (game.configFiles),
// перед каждым сохранением — копия прежней версии в config-backups/.
const fs = require('fs');
const path = require('path');

const MAX_SIZE = 2 * 1024 * 1024;
const KEEP = 10;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function entry(game, rel) {
  const f = (game.configFiles || []).find((x) => x.path === rel);
  if (!f) throw new Error('Этот файл нельзя редактировать в панели');
  return f;
}

function list(dir, game) {
  return (game.configFiles || []).map((f) => {
    const full = path.join(dir, f.path);
    let size = null;
    try {
      size = fs.statSync(full).size;
    } catch {
      /* файла ещё нет */
    }
    return { path: f.path, title: f.title, note: f.note || '', exists: size !== null, size, create: !!f.create };
  });
}

function read(dir, game, rel) {
  const f = entry(game, rel);
  const full = path.join(dir, f.path);
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    if (f.create) return '';
    throw new Error('Файла ещё нет: он появится после первого запуска сервера');
  }
  if (st.size > MAX_SIZE) throw new Error('Файл слишком большой для редактора — откройте папку сервера');
  return fs.readFileSync(full, 'utf8');
}

function backupsDir(dir) {
  return path.join(dir, 'config-backups');
}

function write(dir, game, rel, text, now = new Date()) {
  const f = entry(game, rel);
  text = String(text);
  if (Buffer.byteLength(text) > MAX_SIZE) throw new Error('Слишком большой текст');
  const full = path.join(dir, f.path);
  if (!fs.existsSync(full) && !f.create) throw new Error('Файла ещё нет: он появится после первого запуска сервера');
  if (f.json) {
    try {
      JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error('Ошибка в JSON: ' + e.message.replace(/^JSON\.parse: /, ''));
    }
  }
  if (fs.existsSync(full)) {
    const base = f.path.replace(/[\\/]/g, '__');
    fs.mkdirSync(backupsDir(dir), { recursive: true });
    fs.copyFileSync(full, path.join(backupsDir(dir), `${base}.${stamp(now)}`));
    const old = fs
      .readdirSync(backupsDir(dir))
      .filter((n) => n.startsWith(base + '.'))
      .sort()
      .reverse();
    for (const n of old.slice(KEEP)) fs.rmSync(path.join(backupsDir(dir), n), { force: true });
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + '.igrohost-tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, full);
}

module.exports = { list, read, write, MAX_SIZE };
