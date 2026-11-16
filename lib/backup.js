// Резервные копии: архив папок с миром и настройками в папке backups/ внутри папки сервера.
// В Windows это обычный .zip (его делает системный tar), в Linux — .tar.gz.
const fs = require('fs');
const path = require('path');
const { run, TAR } = require('./util');

const EXT = process.platform === 'win32' ? '.zip' : '.tar.gz';
const NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z-]+\.(zip|tar\.gz)$/;
const REASONS = {
  manual: 'вручную',
  auto: 'перед запуском',
  schedule: 'по расписанию',
  telegram: 'из Telegram',
  'before-restore': 'перед восстановлением',
  'before-update': 'перед обновлением',
  'before-import': 'перед переносом мира',
  'before-modtest': 'перед поиском сломанного мода',
};

const backupsDir = (dir) => path.join(dir, 'backups');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

function checkName(name) {
  if (!NAME_RE.test(String(name))) throw new Error('Некорректное имя копии');
  return name;
}

function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(backupsDir(dir)).filter((n) => NAME_RE.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = fs.statSync(path.join(backupsDir(dir), name));
      const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_([a-z-]+)\./.exec(name);
      return {
        name,
        size: st.size,
        time: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(),
        reason: REASONS[m[7]] || m[7],
      };
    })
    .sort((a, b) => b.time - a.time);
}

/** Создать копию из тех папок paths (относительно dir), которые существуют. */
async function create(dir, paths, reason = 'manual', now = new Date()) {
  if (!REASONS[reason]) throw new Error('Некорректная причина копии');
  const present = paths.filter((p) => fs.existsSync(path.join(dir, p)));
  if (!present.length) throw new Error('Копировать пока нечего: сервер ещё не создал мир');
  fs.mkdirSync(backupsDir(dir), { recursive: true });
  const name = `${stamp(now)}_${reason}${EXT}`;
  const out = path.join(backupsDir(dir), name);
  const args = EXT === '.zip' ? ['-a', '-cf', out, '-C', dir, ...present] : ['-czf', out, '-C', dir, ...present];
  const r = await run(TAR, args);
  // Код 1 у tar — «файл менялся во время чтения»: для работающего сервера это нормально.
  if (r.code !== 0 && !(r.code === 1 && fs.existsSync(out) && fs.statSync(out).size > 0)) {
    fs.rmSync(out, { force: true });
    throw new Error('Не удалось создать копию: ' + (r.out.trim().split('\n').pop() || 'ошибка архиватора'));
  }
  return name;
}

/** Вернуть мир из копии: текущие папки удаляются и заменяются содержимым архива. */
async function restore(dir, name, paths) {
  const file = path.join(backupsDir(dir), checkName(name));
  if (!fs.existsSync(file)) throw new Error('Копия не найдена');
  const tmp = path.join(dir, '.restore-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const r = await run(TAR, ['-xf', file, '-C', tmp]);
    if (r.code !== 0) throw new Error('Копия повреждена и не распаковывается');
    let restored = 0;
    for (const p of paths) {
      const from = path.join(tmp, p);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dir, p);
      fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      restored++;
    }
    if (!restored) throw new Error('В копии нет данных этого сервера');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function remove(dir, name) {
  fs.rmSync(path.join(backupsDir(dir), checkName(name)), { force: true });
}

/** Оставить keep последних автоматических копий; сделанные вручную не трогаем. */
function prune(dir, keep) {
  const auto = list(dir).filter((b) => !/_manual\./.test(b.name));
  for (const b of auto.slice(Math.max(1, keep))) remove(dir, b.name);
}

module.exports = { list, create, restore, remove, prune, REASONS, NAME_RE };
