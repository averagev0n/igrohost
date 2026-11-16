// Enshrouded: Steam-приложение 2278520. Консоли команд нет, журнал — в консоль,
// остановка — сигналом Ctrl+C. Настройки — enshrouded_server.json в папке игры.
// Пароли задаются группами игроков (userGroups): панель ведёт две — «Админ» и «Друзья».
const fs = require('fs');
const path = require('path');

const PRESETS = [['Default', 'Обычная'], ['Relaxed', 'Лёгкая'], ['Hard', 'Сложная'], ['Survival', 'Выживание']];

/** Собрать enshrouded_server.json: берём имеющийся файл и меняем только своё. */
function buildConfig(cur, s) {
  const c = cur && typeof cur === 'object' ? { ...cur } : {};
  c.name = s.name;
  c.saveDirectory = './savegame';
  c.logDirectory = './logs';
  c.ip = '0.0.0.0';
  c.queryPort = s.port;
  c.slotCount = s.players;
  c.gameSettingsPreset = s.preset;
  delete c.gamePort; // больше не используется сервером
  delete c.password; // старый общий пароль заменён группами
  const other = (Array.isArray(c.userGroups) ? c.userGroups : []).filter((g) => g && g.name !== 'Admin' && g.name !== 'Friend');
  c.userGroups = [
    { name: 'Admin', password: s.adminPassword, canKickBan: true, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
    { name: 'Friend', password: s.password, canKickBan: false, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
    ...other,
  ];
  return c;
}

module.exports = {
  id: 'enshrouded',
  title: 'Enshrouded',
  about: 'Выживание и строительство в мире под туманом, до 16 игроков. Сервер лёгкий: хватит 6–8 ГБ памяти.',
  size: 'около 8 ГБ',
  badge: 'En',
  color: '#3b7f8c',
  install: { type: 'steam', appId: 2278520 },
  console: 'none',
  readyRe: /\[Session\] 'HostOnline' \(up\)!/,
  joinRe: /Player '([^']{1,40})' logged in/,
  leaveRe: /Remove Player '([^']{1,40})'/,
  hint: 'У Enshrouded нет консоли команд на сервере — здесь только журнал. Выгнать или заблокировать игрока может тот, кто вошёл с паролем администратора.',
  configFiles: [
    { path: 'game/enshrouded_server.json', title: 'enshrouded_server.json', json: true, note: 'Тонкие правила игры (gameSettings) действуют при сложности Custom. Название, порт и пароли групп Admin и Friend панель перезапишет при запуске' },
  ],
  playersNote: 'У Enshrouded нет консоли на сервере: выгонять и банить может тот, кто вошёл с паролем администратора, — в игре, во вкладке «Социальное».',
  howToJoin: "Enshrouded → «Присоединиться» → найдите сервер по названию или добавьте его по адресу:порту в избранное Steam.",
  fields: [
    { key: 'name', label: 'Название сервера', type: 'text', def: 'Мой сервер Enshrouded', max: 60, required: true },
    { key: 'password', label: 'Пароль для друзей', type: 'text', def: '', max: 40, hint: 'Пусто — вход без пароля. Друзья могут строить и открывать сундуки' },
    { key: 'players', label: 'Игроков', type: 'number', def: 16, min: 1, max: 16 },
    { key: 'preset', label: 'Сложность', type: 'select', def: 'Default', options: PRESETS },
    { key: 'port', label: 'Порт', type: 'number', def: 15637, min: 1024, max: 65535, port: true },
    { key: 'adminPassword', label: 'Пароль администратора', type: 'secret', def: '', generate: true, hint: 'С ним в игре можно выгонять и блокировать игроков' },
  ],
  validate(s) {
    if (s.password && s.password === s.adminPassword) throw new Error('Пароль для друзей не должен совпадать с паролем администратора');
  },
  ports: (s) => [{ port: s.port, proto: 'UDP' }],
  exe: (dir) => path.join(dir, 'game', 'enshrouded_server.exe'),
  saves: () => ['game/savegame', 'game/enshrouded_server.json'],
  launch({ dir, s }) {
    const game = path.join(dir, 'game');
    const file = path.join(game, 'enshrouded_server.json');
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      /* первый запуск */
    }
    fs.writeFileSync(file, JSON.stringify(buildConfig(cur, s), null, '\t'));
    return {
      cmd: path.join(game, 'enshrouded_server.exe'),
      args: [],
      cwd: game,
      // Журнал сервер пишет и в консоль, и в logs/enshrouded_server.log; панель берёт консоль, иначе строки задвоятся.
      ctrlC: true,
      readyAfterMs: 10 * 60000,
      stopGraceMs: 90000,
    };
  },
  buildConfig,
};
