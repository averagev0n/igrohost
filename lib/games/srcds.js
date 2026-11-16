// Team Fortress 2, Left 4 Dead 2, Garry's Mod — на общей основе source.js.
const { makeSourceGame } = require('./source');

const tf2 = makeSourceGame({
  id: 'tf2',
  title: 'Team Fortress 2',
  about: 'Командный шутер Valve: свой сервер для игры с друзьями, тренировок и модов.',
  size: 'около 15 ГБ',
  badge: 'TF',
  color: '#b8383b',
  appId: 232250,
  gameDir: 'tf',
  mapDef: 'cp_dustbowl',
  maps: ['cp_dustbowl', 'ctf_2fort', 'cp_badlands', 'pl_badwater', 'koth_harvest_final', 'cp_granary', 'pl_upward', 'koth_viaduct'],
  maxPlayers: 24,
  playersMax: 32,
});

const l4d2 = makeSourceGame({
  id: 'l4d2',
  title: 'Left 4 Dead 2',
  about: 'Кооператив против орд заражённых: четыре выживших проходят кампанию вместе.',
  size: 'около 10 ГБ',
  badge: 'L4',
  color: '#a3291f',
  appId: 222860,
  gameDir: 'left4dead2',
  mapDef: 'c1m1_hotel',
  maps: ['c1m1_hotel', 'c2m1_highway', 'c3m1_plankcountry', 'c4m1_milltown_a', 'c5m1_waterfront', 'c6m1_riverbank', 'c7m1_docks', 'c8m1_apartment'],
  maxPlayers: 4,
  playersMax: 8,
  extraFields: [
    { key: 'mode', label: 'Режим', type: 'select', def: 'coop', options: [['coop', 'Кооператив'], ['realism', 'Реализм'], ['versus', 'Сражение (8 игроков)'], ['survival', 'Выживание']] },
  ],
  // Без этого к серверу можно попасть только через лобби, а не по адресу.
  extraArgs: (s) => ['+mp_gamemode', s.mode, '+sv_allow_lobby_connect_only', '0'],
  hint: 'Команды: status, changelevel <карта>, say <текст>, kick <имя>. Подключиться: в игре откройте консоль (~) и наберите connect <адрес>.',
});

const gmod = makeSourceGame({
  id: 'gmod',
  title: "Garry's Mod",
  about: 'Песочница на движке Source и сотни режимов: Sandbox, Trouble in Terrorist Town, Prop Hunt и другие.',
  size: 'около 7 ГБ',
  badge: 'GM',
  color: '#1d7fd1',
  appId: 4020,
  gameDir: 'garrysmod',
  mapDef: 'gm_flatgrass',
  maps: ['gm_flatgrass', 'gm_construct'],
  maxPlayers: 16,
  playersMax: 128,
  extraFields: [
    { key: 'gamemode', label: 'Режим', type: 'text', def: 'sandbox', max: 40, required: true, pattern: '^[a-z0-9_]+$', list: ['sandbox', 'terrortown'], hint: 'Название папки режима из garrysmod/gamemodes' },
  ],
  extraArgs: (s) => ['+gamemode', s.gamemode],
});

module.exports = { tf2, l4d2, gmod };
