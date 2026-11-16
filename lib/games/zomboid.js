// Project Zomboid: Steam-приложение 380870. Сервер написан на Java и читает команды из консоли.
// Запускаем java напрямую по образцу StartServer64.bat: в нём зашито 16 ГБ памяти,
// а нам нужно своё значение и без паузы в конце.
// Данные сервера (настройки, мир, база игроков) держим в папке zomboid рядом с игрой (-cachedir).
const fs = require('fs');
const path = require('path');

const SERVER_NAME = 'server';

/** Достать из StartServer64.bat путь к java, её аргументы и список библиотек. */
function parseStartBat(text) {
  const lines = text.split(/\r?\n/);
  const cpLine = lines.find((l) => /^\s*SET\s+PZ_CLASSPATH=/i.test(l));
  const javaLine = lines.find((l) => /java\.exe"?\s/i.test(l) && /zombie\.network\.GameServer/.test(l));
  if (!javaLine) return null;
  const classpath = cpLine ? cpLine.replace(/^\s*SET\s+PZ_CLASSPATH=/i, '').trim() : '';
  const m = /^\s*"?([^"]*?java\.exe)"?\s+(.*)$/i.exec(javaLine);
  if (!m) return null;
  const args = m[2]
    .split(/\s+/)
    .filter((a) => a && !/^%\d$/.test(a))
    .map((a) => (a === '%PZ_CLASSPATH%' ? classpath : a));
  return { java: m[1], args };
}

/** Аргументы java с нашим объёмом памяти и выводом в UTF-8. */
function javaArgs(parsed, memGb) {
  const out = [];
  for (const a of parsed.args) {
    if (/^-Xm[sx]\d+[gGmM]$/.test(a)) continue;
    if (a === 'zombie.network.GameServer') {
      out.push(`-Xms${Math.min(2, memGb)}g`, `-Xmx${memGb}g`);
      // Без этого русские имена в журнале и командах превращаются в мусор.
      out.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8');
    }
    out.push(a);
  }
  return out;
}

/** Поменять или дописать строки «Ключ=значение» в ini, не трогая остальные. */
function setIni(text, values) {
  const lines = (text || '').split(/\r?\n/);
  const left = new Map(Object.entries(values));
  const outLines = lines.map((l) => {
    const m = /^([A-Za-z0-9_]+)=/.exec(l);
    if (!m || !left.has(m[1])) return l;
    const v = left.get(m[1]);
    left.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  while (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();
  for (const [k, v] of left) outLines.push(`${k}=${v}`);
  return outLines.join('\r\n') + '\r\n';
}

const cache = (dir) => path.join(dir, 'zomboid');

module.exports = {
  id: 'zomboid',
  title: 'Project Zomboid',
  about: 'Выживание в городе, полном зомби. Хорош для компании из 2–10 человек. Моды — из Мастерской Steam.',
  size: 'около 7 ГБ',
  badge: 'PZ',
  color: '#8f2f2f',
  install: { type: 'steam', appId: 380870 },
  console: 'stdin',
  stopCmd: 'quit',
  saveCmd: 'save',
  sayCmd: (t) => `servermsg "${t.replace(/"/g, '')}"`,
  readyRe: /SERVER STARTED/,
  joinRe: /\[fully-connected\].*?username="([^"]{1,40})"/,
  leaveRe: /\[disconnect\].*?username="([^"]{1,40})"/,
  hint: 'Команды: players, servermsg "текст", save, kickuser "имя", banuser "имя", setaccesslevel "имя" admin, help.',
  configFiles: [
    { path: 'zomboid/Server/server.ini', title: 'server.ini', note: 'Название, пароль, порты и моды панель перезапишет при запуске; остальное сохранится' },
    { path: 'zomboid/Server/server_SandboxVars.lua', title: 'Правила мира (SandboxVars)', note: 'Действуют для нового мира; часть — и для текущего' },
  ],
  playerCmds: {
    kick: (n) => `kickuser "${((n) => String(n).replace(/"/g, ''))(n)}"`,
    ban: (n) => `banuser "${((n) => String(n).replace(/"/g, ''))(n)}"`,
    admin: (n) => `setaccesslevel "${((n) => String(n).replace(/"/g, ''))(n)}" admin`,
  },
  howToJoin: "Project Zomboid → «Присоединиться» → «Добавить сервер»: IP, порт, имя и пароль.",
  fields: [
    { key: 'name', label: 'Название в списке серверов', type: 'text', def: 'Мой сервер Zomboid', max: 60, required: true },
    { key: 'description', label: 'Описание', type: 'text', def: '', max: 200 },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, pattern: '^[^\\s]*$', hint: 'Пусто — вход без пароля' },
    { key: 'players', label: 'Игроков', type: 'number', def: 8, min: 1, max: 100 },
    { key: 'port', label: 'Порт', type: 'number', def: 16261, min: 1024, max: 65534, port: true, span: 2 },
    { key: 'memory', label: 'Память серверу', type: 'select', def: '4', options: [['2', '2 ГБ'], ['3', '3 ГБ'], ['4', '4 ГБ'], ['6', '6 ГБ'], ['8', '8 ГБ'], ['12', '12 ГБ'], ['16', '16 ГБ']], hint: 'Больше игроков и модов — больше памяти' },
    { key: 'public', label: 'Показывать в общем списке серверов', type: 'bool', def: false },
    { key: 'pvp', label: 'Игроки могут ранить друг друга (PvP)', type: 'bool', def: true },
    { key: 'workshop', label: 'Мастерская Steam: номера предметов', type: 'text', def: '', max: 2000, pattern: '^[0-9;]*$', hint: 'Через точку с запятой: 2169435993;2392709985. Сервер скачает их сам' },
    { key: 'mods', label: 'Моды: их ID', type: 'text', def: '', max: 2000, pattern: '^[^=\\r\\n]*$', hint: 'Через точку с запятой, как в описании мода (Mod ID). Без них моды из Мастерской не включатся' },
    { key: 'adminPassword', label: 'Пароль администратора', type: 'secret', def: '', generate: true, hint: 'Вход в игре под именем admin. Задаётся при первом запуске сервера' },
  ],
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port + 1, proto: 'UDP' }],
  exe: (dir) => path.join(dir, 'game', 'StartServer64.bat'),
  saves: () => ['zomboid/Saves', 'zomboid/Server', 'zomboid/db'],
  launch({ dir, s }) {
    const game = path.join(dir, 'game');
    let bat;
    try {
      bat = parseStartBat(fs.readFileSync(path.join(game, 'StartServer64.bat'), 'utf8'));
    } catch {
      bat = null;
    }
    if (!bat) throw new Error('Не удалось разобрать StartServer64.bat — переустановите сервер');
    // Настройки пишем до запуска: сервер дополнит файл остальными значениями сам.
    const ini = path.join(cache(dir), 'Server', `${SERVER_NAME}.ini`);
    fs.mkdirSync(path.dirname(ini), { recursive: true });
    let cur = '';
    try {
      cur = fs.readFileSync(ini, 'utf8');
    } catch {
      /* первый запуск */
    }
    fs.writeFileSync(
      ini,
      setIni(cur, {
        PublicName: s.name,
        PublicDescription: s.description,
        Password: s.password,
        MaxPlayers: s.players,
        Public: s.public ? 'true' : 'false',
        PVP: s.pvp ? 'true' : 'false',
        DefaultPort: s.port,
        UDPPort: s.port + 1,
        WorkshopItems: s.workshop,
        Mods: s.mods,
      })
    );
    return {
      cmd: path.resolve(game, bat.java),
      args: [
        ...javaArgs(bat, Number(s.memory)),
        `-cachedir=${cache(dir)}`,
        '-servername', SERVER_NAME,
        '-adminusername', 'admin',
        '-adminpassword', s.adminPassword,
        '-port', s.port,
        '-udpport', s.port + 1,
      ],
      cwd: game,
      readyAfterMs: 15 * 60000,
      stopGraceMs: 90000,
    };
  },
  mods: {
    frameworks: [],
    folders: [],
    note: 'Моды из Мастерской Steam подключаются во вкладке «Настройки»: номера предметов и ID модов. Сервер скачает их сам при запуске, а игроки получат их при подключении.',
  },
  parseStartBat,
  javaArgs,
  setIni,
};
