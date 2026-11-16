// Counter-Strike 2: Steam-приложение 730. Журнал — console.log, команды и остановка — Source RCON.
const fs = require('fs');
const path = require('path');

const MODES = {
  competitive: [0, 1],
  casual: [0, 0],
  wingman: [0, 2],
  deathmatch: [1, 2],
  armsrace: [1, 0],
};

const csgo = (dir) => path.join(dir, 'game', 'game', 'csgo');
const METAMOD_LINE = '\t\t\tGame\tcsgo/addons/metamod';

/**
 * Metamod подключается строкой в gameinfo.gi. Обновление CS2 возвращает файл к исходному,
 * поэтому строку проверяем перед каждым запуском. Возвращает новый текст или null, если менять нечего.
 */
function patchGameInfo(text) {
  if (/^\s*Game\s+csgo\/addons\/metamod\s*$/m.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*Game_LowViolence\s+csgo_lv/.test(l));
  if (i < 0) return null;
  lines.splice(i + 1, 0, METAMOD_LINE);
  return lines.join('\r\n');
}

module.exports = {
  id: 'cs2',
  title: 'Counter-Strike 2',
  about: 'Свой сервер для матчей с друзьями и тренировок. Плагины — Metamod и CounterStrikeSharp.',
  size: 'около 60 ГБ',
  badge: 'CS',
  color: '#e08a1e',
  install: { type: 'steam', appId: 730 },
  console: 'link',
  stopCmd: 'quit',
  sayCmd: (t) => `say ${t}`,
  readyRe: /Host activate|GC Connection established|VAC secure mode/i,
  hint: 'Команды: status, changelevel de_mirage, mp_restartgame 1, say <текст>, kick <игрок>, exec <файл>.',
  configFiles: [
    { path: 'game/game/csgo/cfg/server.cfg', title: 'server.cfg', create: true, note: 'Команды, которые сервер выполнит при запуске, по одной в строке' },
  ],
  playersNote: 'CS2 не пишет в журнал, кто зашёл, поэтому список игроков здесь пуст. Узнать, кто на сервере: команда status во вкладке «Консоль»; выгнать — kick <имя>.',
  howToJoin: "CS2 → включите консоль разработчика в настройках → нажмите ~ и введите: connect адрес:порт",
  fields: [
    { key: 'hostname', label: 'Название сервера', type: 'text', def: 'Мой сервер CS2', max: 60, required: true },
    {
      key: 'map', label: 'Карта', type: 'text', def: 'de_dust2', max: 40, required: true, pattern: '^[A-Za-z0-9_]+$',
      list: ['de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_ancient', 'de_anubis', 'de_vertigo', 'de_overpass', 'de_train', 'cs_office', 'cs_italy'],
    },
    { key: 'mode', label: 'Режим', type: 'select', def: 'competitive', options: [['competitive', 'Соревновательный'], ['casual', 'Обычный'], ['wingman', 'Напарники'], ['deathmatch', 'Бой насмерть'], ['armsrace', 'Гонка вооружений']] },
    { key: 'maxplayers', label: 'Игроков', type: 'number', def: 10, min: 2, max: 64 },
    { key: 'port', label: 'Порт', type: 'number', def: 27015, min: 1024, max: 65535, port: true },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, pattern: '^[^\\s;]*$', hint: 'Пусто — вход без пароля' },
    { key: 'gslt', label: 'Токен игрового сервера (GSLT)', type: 'secret', def: '', max: 40, pattern: '^[A-Za-z0-9]*$', hint: 'Нужен, чтобы сервер был виден в интернете. Создаётся на steamcommunity.com/dev/managegameservers, игра 730' },
    { key: 'rconPassword', label: 'Пароль RCON', type: 'secret', def: '', generate: true },
  ],
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port, proto: 'TCP', what: 'RCON, наружу открывать не нужно' }],
  exe: (dir) => path.join(dir, 'game', 'game', 'bin', 'win64', 'cs2.exe'),
  saves: () => ['game/game/csgo/cfg', 'game/game/csgo/addons/counterstrikesharp/configs'],
  link: (s) => ({ type: 'rcon', port: s.port, password: s.rconPassword }),
  launch({ dir, s }) {
    const gi = path.join(csgo(dir), 'gameinfo.gi');
    if (fs.existsSync(path.join(csgo(dir), 'addons', 'metamod')) && fs.existsSync(gi)) {
      const next = patchGameInfo(fs.readFileSync(gi, 'utf8'));
      if (next) fs.writeFileSync(gi, next);
    }
    const [type, mode] = MODES[s.mode] || MODES.competitive;
    const args = [
      '-dedicated', '-console', '-usercon', '-condebug',
      '-port', s.port,
      '-maxplayers', s.maxplayers,
      '+game_type', type,
      '+game_mode', mode,
      '+hostname', s.hostname,
      '+rcon_password', s.rconPassword,
      '+map', s.map,
    ];
    if (s.password) args.push('+sv_password', s.password);
    if (s.gslt) args.push('+sv_setsteamaccount', s.gslt);
    return {
      cmd: path.join(dir, 'game', 'game', 'bin', 'win64', 'cs2.exe'),
      args,
      cwd: path.join(dir, 'game', 'game', 'bin', 'win64'),
      logFile: path.join(csgo(dir), 'console.log'),
      readyAfterMs: 90000,
      stopGraceMs: 20000,
    };
  },
  mods: {
    frameworks: [
      {
        id: 'metamod',
        title: 'Metamod:Source',
        about: 'Основа для всех плагинов CS2.',
        marker: 'game/game/csgo/addons/metamod',
        source: { type: 'metamod', base: 'https://mms.alliedmods.net/mmsdrop/2.0/', latest: 'mmsource-latest-windows' },
        target: 'game/game/csgo',
        removable: false,
      },
      {
        id: 'cssharp',
        title: 'CounterStrikeSharp',
        about: 'Платформа для плагинов на C#: большинство современных плагинов CS2 написано под неё.',
        marker: 'game/game/csgo/addons/counterstrikesharp',
        source: { type: 'github', repo: 'roflmuffin/CounterStrikeSharp', asset: /with-runtime-windows.*\.zip$/i },
        target: 'game/game/csgo',
        requires: 'metamod',
        removable: false,
      },
    ],
    folders: [{ id: 'plugins', title: 'Плагины CounterStrikeSharp', path: 'game/game/csgo/addons/counterstrikesharp/plugins', dirs: true, zip: 'dir', zipRoot: { marker: 'addons', root: 'game/game/csgo' }, needs: 'cssharp' }],
    note: 'Общего каталога плагинов у CS2 нет: скачайте архив плагина (.zip) у автора и добавьте его кнопкой ниже.',
  },
  patchGameInfo,
};
