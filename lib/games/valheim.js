// Valheim: Steam-приложение 896660. Консоли команд нет, журнал пишется в файл,
// остановка — сигналом Ctrl+C (тогда сервер сохраняет мир).
const path = require('path');
const { fileSafe } = require('../util');

module.exports = {
  id: 'valheim',
  title: 'Valheim',
  about: 'Выживание в мире викингов, до 10 игроков. Моды ставятся из каталога Thunderstore.',
  size: 'около 2 ГБ',
  badge: 'Va',
  color: '#b0703a',
  install: { type: 'steam', appId: 896660 },
  console: 'none',
  readyRe: /Game server connected|Opened Steam server/i,
  hint: 'У Valheim нет консоли команд на сервере — здесь только журнал. Админов добавляют в файл adminlist.txt в папке saves.',
  configFiles: [
    { path: 'saves/adminlist.txt', title: 'Администраторы', create: true, note: 'Steam ID игроков, по одному в строке (вида 7656119…)' },
    { path: 'saves/bannedlist.txt', title: 'Заблокированные', create: true, note: 'Steam ID, по одному в строке' },
    { path: 'saves/permittedlist.txt', title: 'Белый список', create: true, note: 'Если в списке есть хоть один Steam ID, зайти смогут только эти игроки' },
  ],
  playersNote: 'У Valheim нет консоли на сервере: выгонять и банить игроков может администратор прямо в игре (F5 → kick / ban). Администраторов добавьте во вкладке «Файлы».',
  fields: [
    { key: 'name', label: 'Название в списке серверов', type: 'text', def: 'Мой сервер Valheim', max: 60, required: true },
    { key: 'world', label: 'Название мира', type: 'text', def: 'Dedicated', max: 40, required: true },
    { key: 'password', label: 'Пароль', type: 'text', def: '', min: 5, max: 40, required: true, generate: true, hint: 'Не короче 5 символов и не часть названия сервера' },
    { key: 'port', label: 'Порт', type: 'number', def: 2456, min: 1024, max: 65534, port: true, span: 2 },
    { key: 'public', label: 'Показывать в общем списке серверов', type: 'bool', def: false },
    { key: 'crossplay', label: 'Кроссплей (игроки с Xbox и Microsoft Store)', type: 'bool', def: false },
    {
      key: 'preset',
      label: 'Сложность',
      type: 'select',
      def: '',
      options: [['', 'Обычная'], ['casual', 'Лёгкая (casual)'], ['easy', 'Попроще (easy)'], ['hard', 'Сложная (hard)'], ['hardcore', 'Хардкор'], ['immersive', 'Погружение'], ['hammer', 'Строительство']],
    },
  ],
  validate(s) {
    const pw = s.password.toLowerCase();
    if (s.name.toLowerCase().includes(pw) || s.world.toLowerCase().includes(pw)) throw new Error('Valheim не примет пароль, который входит в название сервера или мира');
  },
  ports: (s) => [{ port: s.port, proto: 'UDP' }, { port: s.port + 1, proto: 'UDP' }],
  exe: (dir) => path.join(dir, 'game', 'valheim_server.exe'),
  saves: () => ['saves'],
  launch({ dir, s }) {
    const logFile = path.join(dir, 'logs', 'server.log');
    const args = [
      '-nographics', '-batchmode',
      '-name', s.name,
      '-port', s.port,
      '-world', fileSafe(s.world, 'Dedicated'),
      '-password', s.password,
      '-savedir', path.join(dir, 'saves'),
      '-public', s.public ? '1' : '0',
      '-logFile', logFile,
    ];
    if (s.crossplay) args.push('-crossplay');
    if (s.preset) args.push('-preset', s.preset);
    return {
      cmd: path.join(dir, 'game', 'valheim_server.exe'),
      args,
      cwd: path.join(dir, 'game'),
      env: { SteamAppId: '892970' },
      logFile,
      ctrlC: true,
      readyAfterMs: 180000,
      stopGraceMs: 90000,
    };
  },
  mods: {
    frameworks: [
      {
        id: 'bepinex',
        title: 'BepInEx',
        about: 'Загрузчик модов для Valheim. Ставится сам вместе с первым модом из каталога.',
        marker: 'game/BepInEx/core/BepInEx.dll',
        source: { type: 'thunderstore', namespace: 'denikson', name: 'BepInExPack_Valheim' },
        removable: false,
      },
    ],
    folders: [{ id: 'plugins', title: 'Моды', path: 'game/BepInEx/plugins', exts: ['.dll'], dirs: true, needs: 'bepinex' }],
    catalog: { type: 'thunderstore', community: 'valheim', root: 'game', pack: 'BepInExPack_Valheim' },
    note: 'Большинство модов должны стоять и на сервере, и у каждого игрока.',
  },
};
