// Core Keeper: Steam-приложение 1963720. Друзья подключаются по коду Game ID через сеть Steam —
// открывать порты не нужно. Код сервер пишет в GameID.txt. Данные — в папке -datapath, остановка — Ctrl+C.
const fs = require('fs');
const path = require('path');
const { cleanText } = require('../util');

const GAME_ID_RE = /^[A-Za-z0-9]{28,}$/;

module.exports = {
  id: 'corekeeper',
  title: 'Core Keeper',
  about: 'Подземная песочница: копать, строить базу и сражаться с боссами. Лёгкий сервер, порты открывать не нужно.',
  size: 'около 500 МБ',
  badge: 'CK',
  color: '#5d6fb3',
  install: { type: 'steam', appId: 1963720 },
  console: 'none',
  readyRe: /Started session/i,
  joinRe: /^\[userid:\d+\] player (.{1,40}?) (?:connected|joined)/,
  leaveRe: /^\[userid:\d+\] player (.{1,40}?) (?:disconnected|left)/,
  hint: 'У Core Keeper нет консоли команд на сервере — здесь только журнал. Друзья заходят по коду Game ID: «Играть» → «Присоединиться».',
  playersNote: 'У Core Keeper нет консоли на сервере: выгнать игрока можно только перезапуском сервера с новым кодом Game ID (очистите поле в настройках).',
  configFiles: [{ path: 'saves/ServerConfig.json', title: 'ServerConfig.json', json: true, note: 'Появится после первого запуска' }],
  howToJoin: "Core Keeper → «Играть» → «Присоединиться» → введите код Game ID.",
  fields: [
    { key: 'worldName', label: 'Название мира', type: 'text', def: 'Мир Core Keeper', max: 60, required: true },
    { key: 'world', label: 'Номер мира', type: 'number', def: 0, min: 0, max: 29, hint: 'Каждый номер — отдельный мир в папке сервера' },
    { key: 'seed', label: 'Зерно мира', type: 'number', def: 0, min: 0, max: 2147483647, hint: '0 — случайное. Действует только для нового мира' },
    { key: 'mode', label: 'Сложность', type: 'select', def: '0', options: [['0', 'Обычная'], ['1', 'Сложная']], hint: 'Действует только для нового мира' },
    { key: 'players', label: 'Игроков', type: 'number', def: 8, min: 1, max: 100 },
    { key: 'gameId', label: 'Свой код Game ID', type: 'text', def: '', max: 60, hint: 'Пусто — сервер придумает код сам и будет держать его. Не меньше 28 букв и цифр' },
    { key: 'port', label: 'Порт для подключения по адресу', type: 'number', def: 27015, min: 1024, max: 65535, port: true, hint: 'Нужен, только если друзья заходят по IP-адресу, а не по коду' },
  ],
  validate(s) {
    if (s.gameId && !GAME_ID_RE.test(s.gameId)) throw new Error('Код Game ID — не меньше 28 латинских букв и цифр');
  },
  ports: (s) => [{ port: s.port, proto: 'UDP', what: 'только для входа по адресу' }],
  exe: (dir) => path.join(dir, 'game', 'CoreKeeperServer.exe'),
  saves: () => ['saves'],
  /** Код для входа: его сервер пишет в GameID.txt. */
  joinCode(dir) {
    // Файл появляется рядом с сервером; на случай другой версии смотрим и в папке данных.
    for (const f of [path.join(dir, 'game', 'GameID.txt'), path.join(dir, 'saves', 'GameID.txt')]) {
      try {
        const code = fs.readFileSync(f, 'utf8').trim();
        if (GAME_ID_RE.test(code)) return code;
      } catch {
        /* файла нет */
      }
    }
    return null;
  },
  joinCodeLabel: 'Код для входа (Game ID)',
  launch({ dir, s }) {
    fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
    const logFile = path.join(dir, 'game', 'CoreKeeperServerLog.txt');
    const args = [
      '-batchmode', '-logfile', logFile,
      '-datapath', path.join(dir, 'saves'),
      '-world', s.world,
      '-worldname', cleanText(s.worldName, 60),
      '-worldseed', s.seed,
      '-worldmode', s.mode,
      '-maxplayers', s.players,
      '-port', s.port,
    ];
    if (s.gameId) args.push('-gameid', s.gameId);
    return {
      cmd: path.join(dir, 'game', 'CoreKeeperServer.exe'),
      args,
      cwd: path.join(dir, 'game'),
      logFile,
      ctrlC: true,
      readyAfterMs: 120000,
      stopGraceMs: 60000,
    };
  },
};
