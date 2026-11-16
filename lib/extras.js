// Списки игроков (администраторы, баны, белый список), перенос готового сервера из папки,
// приглашение для друзей.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');

// ---- списки игроков по Steam ID ----

const STEAM_ID_RE = /^7656\d{13}$/;

function getList(game, listId) {
  const l = (game.lists || []).find((x) => x.id === listId);
  if (!l) throw new Error('Нет такого списка');
  return l;
}

/** Steam ID из файла: по одному в строке, комментарии (//) и пустые строки пропускаем. */
function readIds(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
  } catch {
    return [];
  }
}

function lists(dir, game) {
  return (game.lists || []).map((l) => ({ id: l.id, title: l.title, note: l.note || '', entries: readIds(path.join(dir, l.file)) }));
}

/** Добавить или убрать Steam ID. Строки-комментарии и чужие строки файла сохраняются. */
function editList(dir, game, listId, value, add) {
  const l = getList(game, listId);
  const id = String(value || '').trim();
  if (add && !STEAM_ID_RE.test(id)) throw new Error('Steam ID — 17 цифр, начинается с 7656. Его видно в профиле Steam или на сайте steamid.io');
  const file = path.join(dir, l.file);
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    /* файла ещё нет */
  }
  lines = lines.filter((x) => x.trim() !== id);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (add) lines.push(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\r\n') + (lines.length ? '\r\n' : ''));
  return readIds(file);
}

// ---- готовый сервер из папки ----

/** Какая игра лежит в папке: по главному файлу сервера (как его ищет панель после установки). */
function detect(src, games) {
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('Папка не найдена');
  const probe = path.join('X', 'Y');
  for (const g of games) {
    const rel = path.relative(path.join(probe, 'game'), g.exe(probe));
    if (!fs.existsSync(path.join(src, rel))) continue;
    // Серверы на движке Source запускаются одним srcds.exe — различаем по папке игры.
    if (g.gameDir && !fs.existsSync(path.join(src, g.gameDir))) continue;
    return g;
  }
  return null;
}

/** Скопировать файлы сервера (robocopy в Windows: быстро и с повторами). */
async function copyServer(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  if (process.platform !== 'win32') {
    fs.cpSync(src, dst, { recursive: true });
    return;
  }
  const r = await run('robocopy', [src, dst, '/E', '/R:1', '/W:1', '/MT:8', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { maxOut: 4000 });
  // Коды robocopy до 8 — успех (с разными оттенками «что-то скопировано»).
  if (r.code === null || r.code >= 8) throw new Error('Не удалось скопировать файлы сервера: ' + (r.out.trim().split('\n').pop() || `код ${r.code}`));
}

// ---- приглашение ----

/**
 * Текст приглашения для чата. info: { title, name, lan, internet, code, codeLabel, password, mods, how }.
 */
function inviteText(info) {
  const lines = [`🎮 Заходи на сервер ${info.title} «${info.name}»!`, ''];
  if (info.code) lines.push(`${info.codeLabel || 'Код'}: ${info.code}`);
  if (info.internet) lines.push(`Адрес: ${info.internet}`);
  if (info.lan) lines.push(info.internet || info.code ? `Если ты в той же сети: ${info.lan}` : `Адрес (в нашей сети): ${info.lan}`);
  if (info.password) lines.push(`Пароль: ${info.password}`);
  if (info.mods && info.mods.length) {
    lines.push('', `Нужны моды (${info.mods.length}):`);
    for (const m of info.mods.slice(0, 30)) lines.push(`• ${m}`);
    if (info.mods.length > 30) lines.push(`• и ещё ${info.mods.length - 30}`);
  }
  if (info.how) lines.push('', `Как зайти: ${info.how}`);
  return lines.join('\n');
}

module.exports = { lists, editList, detect, copyServer, inviteText, STEAM_ID_RE };
