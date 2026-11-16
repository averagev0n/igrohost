// Общая основа для серверов на движке Source (srcds.exe): Team Fortress 2, Left 4 Dead 2, Garry's Mod.
// Журнал пишется в <игра>/console.log (-condebug), команды и остановка — Source RCON, как у CS2.
const fs = require('fs');
const path = require('path');

function makeSourceGame({ id, title, about, size, badge, color, appId, gameDir, maps, mapDef, extraFields = [], extraArgs = () => [], maxPlayers = 24, hint, playersMax = 32 }) {
  const root = (dir) => path.join(dir, 'game', gameDir);
  return {
    id,
    title,
    about,
    size,
    badge,
    color,
    install: { type: 'steam', appId },
    gameDir, // по этой папке панель узнаёт игру при переносе готового сервера
    howToJoin: `${title} → нажмите ~ (консоль; включается в настройках) и введите: connect адрес:порт`,
    console: 'link',
    stopCmd: 'quit',
    sayCmd: (t) => `say ${t.replace(/[";]/g, '')}`,
    readyRe: /gameserver Steam ID|Connection to Steam servers successful|VAC secure mode is activated/i,
    joinRe: /^(?:Client "(.{1,40})" connected \(|(.{1,40}) connected$)/,
    leaveRe: /^Dropped (.{1,40}) from server/,
    hint: hint || 'Команды: status, changelevel <карта>, say <текст>, kick <имя>, exec <файл>.',
    configFiles: [
      { path: `game/${gameDir}/cfg/server.cfg`, title: 'server.cfg', create: true, note: 'Команды, которые сервер выполнит при запуске, по одной в строке' },
    ],
    playerCmds: { kick: (n) => `kick "${String(n).replace(/"/g, '')}"` },
    fields: [
      { key: 'hostname', label: 'Название сервера', type: 'text', def: `Мой сервер ${title}`, max: 60, required: true },
      { key: 'map', label: 'Карта', type: 'text', def: mapDef, max: 60, required: true, pattern: '^[A-Za-z0-9_]+$', list: maps },
      ...extraFields,
      { key: 'maxplayers', label: 'Игроков', type: 'number', def: maxPlayers, min: 2, max: playersMax },
      { key: 'port', label: 'Порт', type: 'number', def: 27015, min: 1024, max: 65535, port: true },
      { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, pattern: '^[^\\s;"]*$', hint: 'Пусто — вход без пароля' },
      { key: 'gslt', label: 'Токен игрового сервера (GSLT)', type: 'secret', def: '', max: 40, pattern: '^[A-Za-z0-9]*$', hint: `Нужен, чтобы сервер был виден в общем списке. Создаётся на steamcommunity.com/dev/managegameservers` },
      { key: 'rconPassword', label: 'Пароль RCON', type: 'secret', def: '', generate: true },
    ],
    ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port, proto: 'TCP', what: 'RCON, наружу открывать не нужно' }],
    exe: (dir) => path.join(dir, 'game', 'srcds.exe'),
    saves: () => [`game/${gameDir}/cfg`],
    link: (s) => ({ type: 'rcon', port: s.port, password: s.rconPassword }),
    launch({ dir, s }) {
      const logFile = path.join(root(dir), 'console.log');
      fs.mkdirSync(path.join(root(dir), 'cfg'), { recursive: true });
      const args = [
        '-console', '-game', gameDir, '-port', s.port, '-condebug', '-nocrashdialog', '-nohltv', '-norestart',
        '+maxplayers', s.maxplayers,
        '+hostname', s.hostname,
        '+rcon_password', s.rconPassword,
        ...extraArgs(s),
        '+map', s.map,
      ];
      if (s.password) args.push('+sv_password', s.password);
      if (s.gslt) args.push('+sv_setsteamaccount', s.gslt);
      return {
        cmd: path.join(dir, 'game', 'srcds.exe'),
        args,
        cwd: path.join(dir, 'game'),
        logFile,
        readyAfterMs: 120000,
        stopGraceMs: 20000,
      };
    },
  };
}

module.exports = { makeSourceGame };
