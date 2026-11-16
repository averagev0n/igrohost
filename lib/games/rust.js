// Rust: Steam-приложение 258550. Журнал — в файл, команды и остановка — через WebRCON.
const path = require('path');

module.exports = {
  id: 'rust',
  title: 'Rust',
  about: 'Выживание с рейдами и вайпами. Тяжёлый сервер: нужно от 12 ГБ памяти. Плагины — Oxide (uMod).',
  size: 'около 15 ГБ',
  badge: 'Ru',
  color: '#c4432b',
  install: { type: 'steam', appId: 258550 },
  console: 'link',
  stopCmd: 'quit',
  saveCmd: 'server.save',
  sayCmd: (t) => `say ${t}`,
  readyRe: /Server startup complete/i,
  joinRe: /\/\d{17}\/(.{1,40}?) joined \[/,
  leaveRe: /\/\d{17}\/(.{1,40}?) disconnecting: /,
  hint: 'Команды: status, say <текст>, kick <игрок>, ban <игрок>, server.save, oxide.reload <плагин>.',
  configFiles: [
    { path: 'game/server/main/cfg/server.cfg', title: 'server.cfg', create: true, note: 'Команды, которые сервер выполнит при запуске, по одной в строке' },
    { path: 'game/server/main/cfg/users.cfg', title: 'Администраторы и модераторы', create: true, note: 'Строки вида: ownerid 7656119… "Имя" "причина"' },
  ],
  playerCmds: { kick: (n) => `kick "${((n) => String(n).replace(/"/g, ''))(n)}"`, ban: (n) => `ban "${((n) => String(n).replace(/"/g, ''))(n)}"` },
  howToJoin: "Rust → нажмите F1 и введите: client.connect адрес:порт",
  fields: [
    { key: 'hostname', label: 'Название сервера', type: 'text', def: 'Мой сервер Rust', max: 80, required: true },
    { key: 'description', label: 'Описание', type: 'text', def: '', max: 200 },
    { key: 'maxplayers', label: 'Игроков', type: 'number', def: 50, min: 1, max: 500 },
    { key: 'level', label: 'Карта', type: 'select', def: 'Procedural Map', options: [['Procedural Map', 'Случайная (Procedural)'], ['Barren', 'Barren — без травы, легче для ПК'], ['HapisIsland', 'Hapis Island'], ['CraggyIsland', 'Craggy Island']] },
    { key: 'worldsize', label: 'Размер карты', type: 'number', def: 3000, min: 1000, max: 6000, hint: 'От 1000 до 6000. Чем больше — тем больше нужно памяти' },
    { key: 'seed', label: 'Зерно карты', type: 'number', def: 12345, min: 0, max: 2147483647 },
    { key: 'pve', label: 'Режим без урона между игроками (PvE)', type: 'bool', def: false },
    { key: 'port', label: 'Порт', type: 'number', def: 28015, min: 1024, max: 65000, port: true, span: 3 },
    { key: 'rconPassword', label: 'Пароль RCON', type: 'secret', def: '', generate: true },
  ],
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port + 2, proto: 'UDP', what: 'список серверов' }],
  exe: (dir) => path.join(dir, 'game', 'RustDedicated.exe'),
  saves: () => ['game/server/main', 'game/oxide/config', 'game/oxide/data'],
  link: (s) => ({ type: 'webrcon', port: s.port + 1, password: s.rconPassword }),
  launch({ dir, s }) {
    const logFile = path.join(dir, 'logs', 'server.log');
    const args = [
        '-batchmode', '-nographics', '-logfile', logFile,
        '+server.identity', 'main',
        '+server.port', s.port,
        '+server.queryport', s.port + 2,
        '+rcon.ip', '127.0.0.1',
        '+rcon.port', s.port + 1,
        '+rcon.password', s.rconPassword,
        '+rcon.web', '1',
        '+app.port', '-1',
        '+server.level', s.level,
        '+server.seed', s.seed,
        '+server.worldsize', s.worldsize,
        '+server.maxplayers', s.maxplayers,
        '+server.hostname', s.hostname,
      '+server.pve', s.pve ? 'true' : 'false',
    ];
    if (s.description) args.push('+server.description', s.description);
    return {
      cmd: path.join(dir, 'game', 'RustDedicated.exe'),
      args,
      cwd: path.join(dir, 'game'),
      logFile,
      readyAfterMs: 20 * 60000,
      stopGraceMs: 120000,
    };
  },
  mods: {
    frameworks: [
      {
        id: 'oxide',
        title: 'Oxide (uMod)',
        about: 'Нужен для плагинов. Игрокам ничего ставить не нужно. После обновления Rust панель переустановит Oxide сама.',
        marker: 'game/RustDedicated_Data/Managed/Oxide.Rust.dll',
        source: { type: 'github', repo: 'OxideMod/Oxide.Rust', asset: /^Oxide\.Rust\.zip$/i },
        target: 'game',
        afterUpdate: true,
        removable: false,
      },
    ],
    folders: [{ id: 'plugins', title: 'Плагины', path: 'game/oxide/plugins', exts: ['.cs'], needs: 'oxide' }],
    catalog: { type: 'umod', game: 'rust', folder: 'game/oxide/plugins', needs: 'oxide' },
  },
};
