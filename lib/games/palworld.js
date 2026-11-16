// Palworld: Steam-приложение 2394010. Настройки — одна длинная строка OptionSettings в ini,
// команды, сохранение и остановка — через встроенный REST API.
const fs = require('fs');
const path = require('path');

/** «(A=1,B="x,y",C=(1,2))» → Map по порядку ключей. */
function parseOptions(line) {
  const m = /OptionSettings=\((.*)\)\s*$/.exec(line.trim());
  const map = new Map();
  if (!m) return map;
  const body = m[1];
  let depth = 0;
  let quote = false;
  let cur = '';
  const flush = () => {
    const i = cur.indexOf('=');
    if (i > 0) map.set(cur.slice(0, i).trim(), cur.slice(i + 1));
    cur = '';
  };
  for (const ch of body) {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '(') depth++;
    else if (!quote && ch === ')') depth--;
    if (ch === ',' && !quote && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return map;
}

const formatOptions = (map) => 'OptionSettings=(' + [...map].map(([k, v]) => `${k}=${v}`).join(',') + ')';
const q = (v) => `"${String(v).replace(/"/g, '')}"`;
const num = (v) => Number(v).toFixed(6);

/** Собрать текст PalWorldSettings.ini: берём за основу имеющиеся настройки и меняем свои ключи. */
function buildIni(baseText, s) {
  const baseLine = (baseText || '').split(/\r?\n/).find((l) => l.trim().startsWith('OptionSettings=')) || 'OptionSettings=()';
  const map = parseOptions(baseLine);
  const set = (k, v) => map.set(k, v);
  set('ServerName', q(s.name));
  set('ServerDescription', q(s.description || ''));
  set('ServerPassword', q(s.password || ''));
  set('AdminPassword', q(s.adminPassword));
  set('ServerPlayerMaxNum', String(s.players));
  set('PublicPort', String(s.port));
  set('ExpRate', num(s.expRate));
  set('PalCaptureRate', num(s.captureRate));
  set('DeathPenalty', s.deathPenalty);
  set('RESTAPIEnabled', 'True');
  set('RESTAPIPort', String(s.port + 1));
  return '[/Script/Pal.PalGameWorldSettings]\r\n' + formatOptions(map) + '\r\n';
}

const iniPath = (dir) => path.join(dir, 'game', 'Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');

module.exports = {
  id: 'palworld',
  title: 'Palworld',
  about: 'Выживание с ловлей палов, до 32 игроков. Серверу нужно от 8 ГБ памяти, лучше 16.',
  size: 'около 5 ГБ',
  badge: 'Pa',
  color: '#2f8fc9',
  install: { type: 'steam', appId: 2394010 },
  console: 'link',
  stopCmd: 'shutdown 1',
  saveCmd: 'save',
  sayCmd: (t) => `announce ${t}`,
  readyRe: /Running Palworld dedicated server/i,
  hint: 'Команды: info, players, save, announce <текст>, kick <id>, ban <id>, shutdown [секунд].',
  configFiles: [
    { path: 'game/Pal/Saved/Config/WindowsServer/PalWorldSettings.ini', title: 'PalWorldSettings.ini', note: 'Название, пароли, порт и множители панель перезапишет при запуске; остальное сохранится' },
  ],
  playersNote: 'У Palworld игроков выгоняют по ID: во вкладке «Консоль» наберите players, затем kick <id> или ban <id>.',
  fields: [
    { key: 'name', label: 'Название сервера', type: 'text', def: 'Мой сервер Palworld', max: 60, required: true },
    { key: 'description', label: 'Описание', type: 'text', def: '', max: 120 },
    { key: 'password', label: 'Пароль для входа', type: 'text', def: '', max: 40, hint: 'Пусто — вход без пароля' },
    { key: 'players', label: 'Игроков', type: 'number', def: 16, min: 1, max: 32 },
    { key: 'port', label: 'Порт', type: 'number', def: 8211, min: 1024, max: 65534, port: true, span: 2 },
    { key: 'public', label: 'Показывать в общем списке серверов', type: 'bool', def: false },
    { key: 'expRate', label: 'Множитель опыта', type: 'number', def: 1, min: 0.1, max: 20, step: 0.1 },
    { key: 'captureRate', label: 'Шанс поимки пала', type: 'number', def: 1, min: 0.5, max: 2, step: 0.1 },
    { key: 'deathPenalty', label: 'Потери при смерти', type: 'select', def: 'All', options: [['None', 'Ничего не теряется'], ['Item', 'Предметы'], ['ItemAndEquipment', 'Предметы и снаряжение'], ['All', 'Всё, включая палов']] },
    { key: 'adminPassword', label: 'Пароль администратора', type: 'secret', def: '', generate: true, hint: 'В игре: /AdminPassword <пароль>' },
  ],
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port + 1, proto: 'TCP', what: 'управление, наружу открывать нельзя' }],
  exe: (dir) => path.join(dir, 'game', 'PalServer.exe'),
  saves: () => ['game/Pal/Saved/SaveGames', 'game/Pal/Saved/Config'],
  link: (s) => ({ type: 'palrest', port: s.port + 1, password: s.adminPassword }),
  launch({ dir, s }) {
    const game = path.join(dir, 'game');
    const ini = iniPath(dir);
    let base = '';
    for (const f of [ini, path.join(game, 'DefaultPalWorldSettings.ini')]) {
      try {
        base = fs.readFileSync(f, 'utf8');
        if (base.includes('OptionSettings=(') && parseOptions(base.split(/\r?\n/).find((l) => l.trim().startsWith('OptionSettings=')) || '').size > 5) break;
      } catch {
        /* файла ещё нет */
      }
    }
    fs.mkdirSync(path.dirname(ini), { recursive: true });
    fs.writeFileSync(ini, buildIni(base, s));
    // Сам PalServer.exe — лишь пускатель; настоящий сервер пишет журнал в консоль только из файла …-Cmd.exe.
    const direct = path.join(game, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');
    const useDirect = fs.existsSync(direct);
    const args = [`-port=${s.port}`, `-players=${s.players}`, '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS'];
    if (s.public) args.push('-publiclobby');
    return {
      cmd: useDirect ? direct : path.join(game, 'PalServer.exe'),
      args: useDirect ? ['Pal', ...args] : args,
      cwd: game,
      readyAfterMs: 45000,
      stopGraceMs: 60000,
    };
  },
  mods: {
    frameworks: [
      {
        id: 'ue4ss',
        title: 'UE4SS',
        about: 'Загрузчик скриптовых модов (Lua). Для модов-файлов .pak он не нужен. Если после установки сервер перестал запускаться — удалите файл dwmapi.dll из папки Pal\\Binaries\\Win64.',
        marker: 'game/Pal/Binaries/Win64/dwmapi.dll',
        source: { type: 'github', repo: 'UE4SS-RE/RE-UE4SS', asset: /^UE4SS_v[\d.]+\.zip$/i },
        target: 'game/Pal/Binaries/Win64',
        removable: false,
      },
    ],
    folders: [
      { id: 'paks', title: 'Моды .pak', path: 'game/Pal/Content/Paks/~mods', exts: ['.pak'] },
      { id: 'lua', title: 'Моды UE4SS', path: 'game/Pal/Binaries/Win64/ue4ss/Mods', dirs: true, zip: 'dir', needs: 'ue4ss', keep: /^(shared|BPModLoaderMod|BPML_GenericFunctions|CheatManagerEnablerMod|ConsoleCommandsMod|ConsoleEnablerMod|Keybinds|LineTraceMod|SplitScreenMod|ActorDumperMod|jsbLuaProfilerMod|mods\.txt|mods\.json)$/i },
    ],
    note: 'Общего каталога модов у Palworld нет: скачайте мод (например, с Nexus Mods) и добавьте файл кнопкой ниже.',
  },
  parseOptions,
  formatOptions,
  buildIni,
};
