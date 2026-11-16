// V Rising: Steam-приложение 1829350. Настройки — ServerHostSettings.json в папке данных сервера
// (-persistentDataPath), основа — образец из папки игры. Команды — Source RCON, остановка — Ctrl+C.
const fs = require('fs');
const path = require('path');

const data = (dir) => path.join(dir, 'save-data');

/** Собрать ServerHostSettings.json поверх образца: чужие ключи сохраняются. */
function buildHostSettings(base, s) {
  const c = base && typeof base === 'object' ? { ...base } : {};
  c.Name = s.name;
  c.Description = s.description;
  c.Port = s.port;
  c.QueryPort = s.port + 1;
  c.MaxConnectedUsers = s.players;
  c.MaxConnectedAdmins = 4;
  c.SaveName = 'world1';
  c.Password = s.password;
  c.Secure = true;
  c.ListOnSteam = !!s.public;
  c.ListOnEOS = !!s.public;
  c.GameSettingsPreset = s.preset;
  c.Rcon = { ...(c.Rcon || {}), Enabled: true, Port: s.port + 2, Password: s.rconPassword };
  return c;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

module.exports = {
  id: 'vrising',
  title: 'V Rising',
  about: 'Выживание за вампира: замок, кланы и охота на боссов. Подходит и для компании из двух-трёх друзей.',
  size: 'около 2 ГБ',
  badge: 'VR',
  color: '#8e1b2c',
  install: { type: 'steam', appId: 1829350 },
  console: 'link',
  sayCmd: (t) => `announce ${t}`,
  readyRe: /Startup Completed|Server Startup Completed/i,
  hint: 'Команды RCON: announce <текст>, announcerestart <минут>. Администраторы — во вкладке «Файлы».',
  lists: [
    { id: 'admins', file: 'save-data/Settings/adminlist.txt', title: 'Администраторы', note: 'В игре администратор вводит в консоли (~) adminauth' },
    { id: 'banned', file: 'save-data/Settings/banlist.txt', title: 'Заблокированные' },
  ],
  playersNote: 'V Rising не пишет в журнал, кто зашёл, поэтому список игроков здесь пуст. Выгонять и банить может администратор в игре (консоль ~: adminauth, затем kick / banuser).',
  configFiles: [
    { path: 'save-data/Settings/adminlist.txt', title: 'Администраторы', create: true, note: 'Steam ID игроков, по одному в строке. В игре администратор пишет в консоли (~) adminauth' },
    { path: 'save-data/Settings/banlist.txt', title: 'Заблокированные', create: true, note: 'Steam ID, по одному в строке' },
    { path: 'save-data/Settings/ServerGameSettings.json', title: 'Правила игры', json: true, note: 'Появится после первого запуска. Действует при пресете «Свой» или для нового мира' },
  ],
  howToJoin: "V Rising → «Онлайн-игра» → «Найти серверы» → «Прямое подключение» → адрес:порт.",
  fields: [
    { key: 'name', label: 'Название сервера', type: 'text', def: 'Мой сервер V Rising', max: 60, required: true },
    { key: 'description', label: 'Описание', type: 'text', def: '', max: 200 },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, hint: 'Пусто — вход без пароля' },
    { key: 'players', label: 'Игроков', type: 'number', def: 10, min: 1, max: 60 },
    {
      key: 'preset',
      label: 'Правила',
      type: 'select',
      def: 'StandardPvE',
      options: [['StandardPvE', 'PvE — без сражений между игроками'], ['StandardPvP', 'PvP'], ['DuoPvP', 'PvP по двое'], ['Level30PvP', 'PvP с 30 уровня'], ['', 'Свой (из файла правил)']],
    },
    { key: 'port', label: 'Порт', type: 'number', def: 9876, min: 1024, max: 65533, port: true, span: 3 },
    { key: 'public', label: 'Показывать в общем списке серверов', type: 'bool', def: false },
    { key: 'rconPassword', label: 'Пароль RCON', type: 'secret', def: '', generate: true },
  ],
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port + 1, proto: 'UDP', what: 'список серверов' }, { port: s.port + 2, proto: 'TCP', what: 'RCON, наружу открывать не нужно' }],
  exe: (dir) => path.join(dir, 'game', 'VRisingServer.exe'),
  saves: () => ['save-data/Saves', 'save-data/Settings'],
  link: (s) => ({ type: 'rcon', port: s.port + 2, password: s.rconPassword }),
  launch({ dir, s }) {
    const settings = path.join(data(dir), 'Settings');
    fs.mkdirSync(settings, { recursive: true });
    const file = path.join(settings, 'ServerHostSettings.json');
    const base = readJson(file) || readJson(path.join(dir, 'game', 'VRisingServer_Data', 'StreamingAssets', 'Settings', 'ServerHostSettings.json'));
    fs.writeFileSync(file, JSON.stringify(buildHostSettings(base, s), null, 2));
    const logFile = path.join(dir, 'logs', 'server.log');
    return {
      cmd: path.join(dir, 'game', 'VRisingServer.exe'),
      args: ['-persistentDataPath', data(dir), '-logFile', logFile],
      cwd: path.join(dir, 'game'),
      logFile,
      ctrlC: true,
      readyAfterMs: 180000,
      stopGraceMs: 90000,
    };
  },
  buildHostSettings,
};
