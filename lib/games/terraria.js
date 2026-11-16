// Terraria: сервер скачивается архивом с terraria.org, консоль — обычный ввод/вывод.
const fs = require('fs');
const path = require('path');
const { fileSafe } = require('../util');

const tshockExe = (dir) => path.join(dir, 'tshock', 'TShock.Server.exe');

/** Текст serverconfig.txt по настройкам. */
function serverConfig(dir, s) {
  const world = fileSafe(s.worldname, 'World');
  const lines = [
    `world=${path.join(dir, 'worlds', world + '.wld')}`,
    `worldpath=${path.join(dir, 'worlds')}`,
    `worldname=${world}`,
    `autocreate=${s.size}`,
    `difficulty=${s.difficulty}`,
    `maxplayers=${s.maxplayers}`,
    `port=${s.port}`,
    `password=${s.password || ''}`,
    `motd=${s.motd || ''}`,
    'secure=1',
    'upnp=0',
  ];
  if (s.seed) lines.push(`seed=${s.seed}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  id: 'terraria',
  title: 'Terraria',
  about: 'Двухмерная песочница с боссами. Самый лёгкий сервер — потянет любой компьютер.',
  size: 'около 50 МБ',
  badge: 'Te',
  color: '#3f9b4b',
  install: { type: 'terraria' },
  console: 'stdin',
  stopCmd: 'exit',
  saveCmd: 'save',
  sayCmd: (t) => `say ${t}`,
  readyRe: /Server started|Listening on port/i,
  joinRe: /^(.{1,40}) has joined\.$/,
  leaveRe: /^(.{1,40}) has left\.$/,
  hint: 'Команды: help, playing, say <текст>, kick <игрок>, save, time, dawn, settle.',
  configFiles: [
    { path: 'tshock/tshock/config.json', title: 'Настройки TShock', json: true, note: 'Появится после первого запуска с TShock' },
  ],
  playerCmds: { kick: (n) => `kick ${n}`, ban: (n) => `ban ${n}` },
  fields: [
    { key: 'worldname', label: 'Название мира', type: 'text', def: 'World', max: 40, required: true },
    { key: 'size', label: 'Размер мира', type: 'select', def: '2', options: [['1', 'Маленький'], ['2', 'Средний'], ['3', 'Большой']], hint: 'Действует только при создании нового мира' },
    { key: 'difficulty', label: 'Сложность', type: 'select', def: '0', options: [['0', 'Классика'], ['1', 'Эксперт'], ['2', 'Мастер'], ['3', 'Путешествие']], hint: 'Действует только при создании нового мира' },
    { key: 'maxplayers', label: 'Игроков', type: 'number', def: 8, min: 1, max: 255 },
    { key: 'port', label: 'Порт', type: 'number', def: 7777, min: 1024, max: 65535, port: true },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, hint: 'Пусто — вход без пароля' },
    { key: 'motd', label: 'Приветствие', type: 'text', def: '', max: 120 },
    { key: 'seed', label: 'Зерно мира', type: 'text', def: '', max: 40, hint: 'Необязательно' },
  ],
  ports: (s) => [{ port: s.port, proto: 'TCP' }],
  exe: (dir) => path.join(dir, 'game', 'TerrariaServer.exe'),
  saves: () => ['worlds', 'tshock/tshock'],
  launch({ dir, s }) {
    fs.mkdirSync(path.join(dir, 'worlds'), { recursive: true });
    const cfg = path.join(dir, 'serverconfig.txt');
    fs.writeFileSync(cfg, serverConfig(dir, s));
    const ts = tshockExe(dir);
    const useTs = fs.existsSync(ts);
    return {
      cmd: useTs ? ts : path.join(dir, 'game', 'TerrariaServer.exe'),
      args: ['-config', cfg],
      cwd: useTs ? path.dirname(ts) : path.join(dir, 'game'),
      utf8Console: true,
      // Настоящий сервер читает команды только с консоли, а не из перенаправленного ввода.
      conInput: true,
      // Перед своими сообщениями сервер печатает приглашение «: ».
      stripRe: /^(?:: )+/,
      readyAfterMs: 180000,
    };
  },
  mods: {
    frameworks: [
      {
        id: 'tshock',
        title: 'TShock',
        about: 'Сервер с плагинами: права, регионы, защита от читов. Игрокам ничего ставить не нужно. Мир остаётся тот же.',
        marker: 'tshock/TShock.Server.exe',
        source: { type: 'github', repo: 'Pryaxis/TShock', asset: /win-x64.*\.zip$/i },
        target: 'tshock',
        flatten: 'TShock.Server.exe',
        removable: true,
      },
    ],
    folders: [{ id: 'plugins', title: 'Плагины TShock', path: 'tshock/ServerPlugins', exts: ['.dll'], needs: 'tshock', keep: /^(TShockAPI|TerrariaServerAPI|OTAPI|ModFramework).*\.dll$/i }],
  },
  serverConfig,
};
