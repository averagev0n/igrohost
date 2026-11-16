// 7 Days to Die: Steam-приложение 294420. Журнал пишется в файл, команды и остановка — через telnet.
// Свой serverconfig.xml держим в папке сервера, а не игры: обновление игры его не затрёт.
// Основа — образец, который лежит в папке игры; меняем только свои ключи.
// С версии 3.0 сложность и правила игры задаются «кодом песочницы» (SandboxCode), а не отдельными ключами.
const fs = require('fs');
const path = require('path');

const xmlEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Поменять значения <property name="…" value="…"/>; недостающие ключи дописать в конец. */
function setProperties(xml, values) {
  let text = xml && /<ServerSettings[\s>]/.test(xml) ? xml : '<?xml version="1.0"?>\n<ServerSettings>\n</ServerSettings>\n';
  for (const [name, value] of Object.entries(values)) {
    const line = `<property name="${name}" value="${xmlEsc(value)}"/>`;
    // Ищем только действующую строку: в образце есть закомментированные, их не трогаем.
    const re = new RegExp(`^(\\s*)<property\\s+name="${name}"\\s+value="[^"]*"\\s*/>`, 'm');
    if (re.test(text)) text = text.replace(re, (_, sp) => sp + line);
    else text = text.replace(/<\/ServerSettings>/, `\t${line}\n</ServerSettings>`);
  }
  return text;
}

const WORLDS = [['Navezgane', 'Навезгане — готовая карта'], ['RWG', 'Случайная карта (создаётся при первом запуске, долго)']];

module.exports = {
  id: 'sdtd',
  title: '7 Days to Die',
  about: 'Кооперативное выживание: днём строите и ищете припасы, на седьмую ночь — орда. Серверу нужно от 8 ГБ памяти.',
  size: 'около 18 ГБ',
  badge: '7D',
  color: '#7a6a2e',
  install: { type: 'steam', appId: 294420 },
  console: 'link',
  stopCmd: 'shutdown',
  saveCmd: 'saveworld',
  sayCmd: (t) => `say "${t.replace(/"/g, '')}"`,
  readyRe: /GameServer\.LogOn successful|StartGame done/,
  joinRe: /PlayerSpawnedInWorld \(reason: (?:Enter|Join)Multiplayer.*?PlayerName='([^']{1,40})'/,
  leaveRe: /Player disconnected: .*?PlayerName='([^']{1,40})'/,
  hint: 'Команды: listplayers, say "текст", saveworld, kick <имя>, admin add <имя> 0, settime day, help.',
  configFiles: [
    { path: 'serverconfig.xml', title: 'serverconfig.xml', note: 'Название, пароль, порт, карту и telnet панель перезапишет при запуске; остальное сохранится' },
    { path: 'saves/Saves/serveradmin.xml', title: 'Администраторы и баны', note: 'Появится после первого запуска' },
  ],
  playerCmds: {
    kick: (n) => `kick "${((n) => String(n).replace(/"/g, ''))(n)}"`,
    ban: (n) => `ban add "${((n) => String(n).replace(/"/g, ''))(n)}" 10 years`,
    admin: (n) => `admin add "${((n) => String(n).replace(/"/g, ''))(n)}" 0`,
  },
  fields: [
    { key: 'name', label: 'Название сервера', type: 'text', def: 'Мой сервер 7 Days', max: 60, required: true },
    { key: 'description', label: 'Описание', type: 'text', def: '', max: 200 },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, hint: 'Пусто — вход без пароля' },
    { key: 'players', label: 'Игроков', type: 'number', def: 8, min: 1, max: 32 },
    { key: 'world', label: 'Карта', type: 'select', def: 'Navezgane', options: WORLDS },
    { key: 'seed', label: 'Зерно случайной карты', type: 'text', def: 'igrohost', max: 40, required: true },
    { key: 'worldSize', label: 'Размер случайной карты', type: 'select', def: '6144', options: [['6144', '6 км — быстрее создаётся'], ['8192', '8 км'], ['10240', '10 км — нужно много памяти']] },
    { key: 'gameName', label: 'Название сохранения', type: 'text', def: 'Мир', max: 40, required: true, hint: 'Новое название — новый мир; старый остаётся в копиях и в папке сервера' },
    { key: 'port', label: 'Порт', type: 'number', def: 26900, min: 1024, max: 65000, port: true, span: 5 },
    { key: 'public', label: 'Показывать в общем списке серверов', type: 'bool', def: false },
    { key: 'eac', label: 'Античит EasyAntiCheat', type: 'bool', def: true },
    { key: 'sandbox', label: 'Код песочницы (SandboxCode)', type: 'text', def: '', max: 4000, pattern: '^[^"<>&\\s]*$', hint: 'Сложность и правила с версии 3.0: настройте их в меню игры, скопируйте код и вставьте сюда. Пусто — стандартные' },
  ],
  validate(s) {
    if (s.world === 'RWG' && !s.seed) throw new Error('Для случайной карты нужно зерно');
  },
  // Игровой порт — TCP и UDP, ещё три следом — UDP. Порт +4 — telnet для панели, наружу не нужен.
  ports: (s) => [
    { port: s.port, proto: 'TCP' },
    { port: s.port, proto: 'UDP' },
    { port: s.port + 1, proto: 'UDP' },
    { port: s.port + 2, proto: 'UDP' },
    { port: s.port + 3, proto: 'UDP' },
    { port: s.port + 4, proto: 'TCP', what: 'telnet, наружу открывать не нужно' },
  ],
  exe: (dir) => path.join(dir, 'game', '7DaysToDieServer.exe'),
  saves: () => ['saves/Saves', 'saves/GeneratedWorlds'],
  // Пароль telnet не задаём: тогда сервер слушает telnet только на этом компьютере.
  link: (s) => ({ type: 'telnet', port: s.port + 4, password: '' }),
  launch({ dir, s }) {
    const game = path.join(dir, 'game');
    const cfg = path.join(dir, 'serverconfig.xml');
    let base = '';
    for (const f of [cfg, path.join(game, 'serverconfig.xml')]) {
      try {
        base = fs.readFileSync(f, 'utf8');
        break;
      } catch {
        /* файла нет */
      }
    }
    const values = {
      ServerName: s.name,
      ServerDescription: s.description,
      ServerPassword: s.password,
      ServerPort: s.port,
      ServerVisibility: s.public ? 2 : 0,
      ServerMaxPlayerCount: s.players,
      GameWorld: s.world,
      WorldGenSeed: s.seed,
      WorldGenSize: s.worldSize,
      GameName: s.gameName,
      EACEnabled: s.eac ? 'true' : 'false',
      UserDataFolder: path.join(dir, 'saves'),
      AdminFileName: 'serveradmin.xml',
      TelnetEnabled: 'true',
      TelnetPort: s.port + 4,
      TelnetPassword: '',
      TerminalWindowEnabled: 'false',
      WebDashboardEnabled: 'false',
    };
    if (s.sandbox) values.SandboxCode = s.sandbox;
    fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
    fs.writeFileSync(cfg, setProperties(base, values));
    const logFile = path.join(dir, 'logs', 'server.log');
    return {
      cmd: path.join(game, '7DaysToDieServer.exe'),
      args: ['-logfile', logFile, '-quit', '-batchmode', '-nographics', `-configfile=${cfg}`, '-dedicated'],
      cwd: game,
      logFile,
      readyPort: s.port + 4,
      readyAfterMs: 30 * 60000,
      stopGraceMs: 120000,
    };
  },
  mods: {
    frameworks: [],
    folders: [{ id: 'mods', title: 'Моды', path: 'game/Mods', dirs: true, zip: 'dir' }],
    note: 'Мод — это папка с файлом ModInfo.xml: добавьте его архивом .zip. Многие моды нужно поставить и игрокам. Модам с кодом (.dll) мешает античит — выключите EasyAntiCheat в настройках.',
  },
  setProperties,
};
