// Поиск сломанного мода, Discord-бот, списки игроков, перенос готового сервера, приглашение,
// история нагрузки, журнал прошлого запуска.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const modtest = require('../lib/modtest');
const { interactionText, createDiscordBot, COMMANDS } = require('../lib/discordbot');
const extras = require('../lib/extras');
const { GAMES, getGame } = require('../lib/games');
const { createApp } = require('../lib/app');
const { sleep } = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));
const FAKE = path.join(__dirname, 'fake-server.js');
const put = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('не дождались условия');
}

// ---- поиск сломанного мода ----

test('поиск мода: план деления пополам находит виновника за log2(n) запусков', () => {
  const mods = Array.from({ length: 16 }, (_, k) => ({ key: `p/m${String(k).padStart(2, '0')}`, deps: [] }));
  const bad = 'p/m11';
  const s = modtest.createSearch(mods);
  let step;
  let runs = 0;
  while (!(step = s.next()).done) {
    s.report(step.enable.includes(bad));
    runs++;
  }
  assert.strictEqual(step.culprit, bad);
  assert.strictEqual(runs, 5); // 1 полный запуск + 4 деления
  // Без падения со всеми модами искать нечего.
  const s2 = modtest.createSearch(mods);
  s2.next();
  s2.report(false);
  assert.ok(s2.next().noRepro);
});

test('поиск мода: зависимости Thunderstore включаются вместе с модом, файлы уезжают и возвращаются', () => {
  const dir = tmp();
  const game = getGame('valheim');
  const base = path.join(dir, 'game', 'BepInEx', 'plugins');
  put(path.join(base, 'Lib-Core', 'manifest.json'), JSON.stringify({ dependencies: [] }));
  put(path.join(base, 'Me-Mod', 'manifest.json'), JSON.stringify({ dependencies: ['Lib-Core-1.2.3', 'denikson-BepInExPack_Valheim-5.4.2'] }));
  put(path.join(base, 'Other-Thing', 'manifest.json'), '{}');
  const mods = modtest.collect(dir, game);
  assert.deepStrictEqual(mods.map((m) => [m.key, m.deps]), [
    ['plugins/Lib-Core', []],
    ['plugins/Me-Mod', ['plugins/Lib-Core']],
    ['plugins/Other-Thing', []],
  ]);
  assert.deepStrictEqual(modtest.closure(['plugins/Me-Mod'], mods).sort(), ['plugins/Lib-Core', 'plugins/Me-Mod']);
  modtest.apply(dir, game, mods, ['plugins/Other-Thing']);
  assert.deepStrictEqual(fs.readdirSync(base), ['Other-Thing']);
  modtest.apply(dir, game, mods, ['plugins/Lib-Core']);
  assert.deepStrictEqual(fs.readdirSync(base).sort(), ['Lib-Core']);
  assert.strictEqual(modtest.restoreAll(dir, game), 2);
  assert.deepStrictEqual(fs.readdirSync(base).sort(), ['Lib-Core', 'Me-Mod', 'Other-Thing']);
  assert.ok(!fs.existsSync(path.join(dir, modtest.OFF_DIR)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('поиск мода целиком: пробные запуски находят «плохой» плагин, мир и моды возвращаются', async () => {
  const dataDir = tmp();
  const events = [];
  const app = createApp({ dataDir, emit: (ch, p) => events.push({ ch, p }), modtestHoldMs: 300, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const a = await app.call('inst:create', { game: 'rust', name: 'Тест' });
  const dir = path.join(dataDir, 'servers', a.id);
  const plugins = path.join(dir, 'game', 'oxide', 'plugins');
  for (const n of ['Alpha', 'Beta', 'Bad', 'Gamma', 'Delta']) put(path.join(plugins, `${n}.cs`), `// ${n}`);
  put(path.join(dir, 'game', 'server', 'main', 'world.sav'), 'хороший мир');
  const game = getGame('rust');
  const orig = { launch: game.launch, console: game.console, stopCmd: game.stopCmd, readyRe: game.readyRe };
  game.launch = () => ({ cmd: process.execPath, args: [FAKE, '--crash-if', path.join(plugins, 'Bad.cs'), '--world', path.join(dir, 'game', 'server', 'main')], cwd: dir });
  Object.assign(game, { console: 'stdin', stopCmd: 'exit', readyRe: /Server started/ });
  try {
    await app.call('modtest:start', { id: a.id });
    await until(async () => (await app.call('modtest:get', { id: a.id })).done, 60000);
    const t = await app.call('modtest:get', { id: a.id });
    assert.strictEqual(t.error, '');
    assert.strictEqual(t.result.culprit, 'Bad.cs');
    assert.ok(t.runs >= 3 && t.runs <= 5, `запусков ${t.runs}`);
    assert.deepStrictEqual(fs.readdirSync(plugins).sort(), ['Alpha.cs', 'Bad.cs', 'Beta.cs', 'Delta.cs', 'Gamma.cs']);
    // Поддельный сервер перезаписал «мир» — панель вернула его из копии.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'game', 'server', 'main', 'world.sav'), 'utf8'), 'хороший мир');
    assert.ok(!fs.existsSync(path.join(dir, 'modtest.json')));
    assert.ok(events.some((e) => e.ch === 'toast' && /ломает мод «Bad\.cs»/.test(e.p.text)));
    assert.ok(!events.some((e) => e.ch === 'toast' && /неожиданно остановился/.test(e.p.text))); // пробные падения — не падения
  } finally {
    Object.assign(game, orig);
    await app.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- Discord-бот ----

test('Discord: команды со слешем превращаются в те же команды, что в Telegram', async () => {
  assert.strictEqual(interactionText({ name: 'on', options: [{ name: 'server', value: 2 }] }), '/on 2');
  assert.strictEqual(interactionText({ name: 'status' }), '/status');
  assert.deepStrictEqual(COMMANDS.map((c) => c.name), ['status', 'on', 'off', 'restart', 'backup']);
  assert.ok(COMMANDS.every((c) => c.default_member_permissions === '32' && c.dm_permission === false));

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const bot = createDiscordBot({ fetchFn: fakeFetch, WS: null, onCommand: async (text, reply) => reply(`получил ${text}`) });
  await bot._onInteraction({ type: 2, id: '1', token: 'tk', data: { name: 'off', options: [{ name: 'server', value: 1 }] } });
  const cb = calls.find((c) => c.url.endsWith('/interactions/1/tk/callback'));
  assert.strictEqual(cb.body.type, 4);
  assert.strictEqual(cb.body.data.content, 'получил /off 1');
  assert.deepStrictEqual(cb.body.data.allowed_mentions, { parse: [] });
  await assert.rejects(bot.check('плохой токен'), /не похоже на токен/);
});

test('Discord в панели: /status и управление по той же логике, что у Telegram', async () => {
  const dataDir = tmp();
  const app = createApp({ dataDir, emit: () => {}, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await app.call('inst:create', { game: 'terraria', name: 'Мир' });
  assert.match(await app._discordCommand('/status'), /1\. ⚪ Terraria «Мир» — выключен/);
  assert.match(await app._discordCommand('/on'), /Не получилось: Сначала установите сервер/);
  app.store.data.discordBot = { control: false };
  assert.match(await app._discordCommand('/off 1'), /Управление .* выключено/);
  await app.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- списки, перенос сервера, приглашение ----

test('списки игроков: Steam ID добавляются и убираются, чужие строки остаются', () => {
  const dir = tmp();
  const v = getGame('valheim');
  put(path.join(dir, 'saves', 'adminlist.txt'), '// List admin players ID  ONE per line\r\n76561198000000001\r\n');
  assert.deepStrictEqual(extras.lists(dir, v).map((l) => [l.id, l.entries]), [['admins', ['76561198000000001']], ['banned', []], ['permitted', []]]);
  extras.editList(dir, v, 'admins', '76561198000000002', true);
  extras.editList(dir, v, 'admins', '76561198000000002', true); // повтор не дублирует
  assert.deepStrictEqual(extras.editList(dir, v, 'admins', '76561198000000001', false), ['76561198000000002']);
  assert.match(fs.readFileSync(path.join(dir, 'saves', 'adminlist.txt'), 'utf8'), /^\/\/ List admin players/);
  assert.throws(() => extras.editList(dir, v, 'admins', 'Вася', true), /17 цифр/);
  assert.throws(() => extras.editList(dir, v, 'нет', '76561198000000002', true), /Нет такого списка/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('перенос готового сервера: игра узнаётся по главному файлу, файлы копируются', async () => {
  const root = tmp();
  put(path.join(root, 'vh', 'valheim_server.exe'), 'exe');
  put(path.join(root, 'vh', 'valheim_server_Data', 'data.bin'), 'данные');
  put(path.join(root, 'l4d', 'srcds.exe'), 'exe');
  put(path.join(root, 'l4d', 'left4dead2', 'gameinfo.txt'), 'x');
  put(path.join(root, 'cs', 'game', 'bin', 'win64', 'cs2.exe'), 'exe');
  put(path.join(root, 'nothing', 'readme.txt'), 'x');
  assert.strictEqual(extras.detect(path.join(root, 'vh'), GAMES).id, 'valheim');
  assert.strictEqual(extras.detect(path.join(root, 'l4d'), GAMES).id, 'l4d2');
  assert.strictEqual(extras.detect(path.join(root, 'cs'), GAMES).id, 'cs2');
  assert.strictEqual(extras.detect(path.join(root, 'nothing'), GAMES), null);
  assert.throws(() => extras.detect(path.join(root, 'нет'), GAMES), /не найдена/);
  const dst = path.join(root, 'copy');
  await extras.copyServer(path.join(root, 'vh'), dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'valheim_server_Data', 'data.bin'), 'utf8'), 'данные');
  assert.ok(fs.existsSync(path.join(root, 'vh', 'valheim_server.exe'))); // исходник на месте

  // Через панель: сервер появляется сразу, а файлы копируются в фоне.
  const dataDir = tmp();
  const app = createApp({ dataDir, emit: () => {} });
  await assert.rejects(app.call('import:detect', { path: path.join(root, 'nothing') }), /не нашлось сервера/);
  assert.deepStrictEqual(await app.call('import:detect', { path: path.join(root, 'vh') }), { game: 'valheim', title: 'Valheim' });
  const v = await app.call('import:create', { path: path.join(root, 'vh'), name: 'Мой старый' });
  await until(async () => (await app.call('inst:list'))[0].installed && (await app.call('inst:list'))[0].state === 'stopped');
  assert.ok(fs.existsSync(path.join(dataDir, 'servers', v.id, 'game', 'valheim_server_Data', 'data.bin')));
  await app.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('приглашение: адрес, код, пароль, моды и как зайти', () => {
  const text = extras.inviteText({ title: 'Valheim', name: 'Север', lan: '192.168.1.5:2456', internet: 'party.joinmc.link', password: 'тайна', mods: ['ValheimPlus 0.9', 'Jotunn 2.3'], how: 'Valheim → «Присоединиться»' });
  assert.strictEqual(
    text,
    ['🎮 Заходи на сервер Valheim «Север»!', '', 'Адрес: party.joinmc.link', 'Если ты в той же сети: 192.168.1.5:2456', 'Пароль: тайна', '', 'Нужны моды (2):', '• ValheimPlus 0.9', '• Jotunn 2.3', '', 'Как зайти: Valheim → «Присоединиться»'].join('\n')
  );
  assert.match(extras.inviteText({ title: 'Core Keeper', name: 'Пещеры', code: 'ABC', codeLabel: 'Код для входа (Game ID)', lan: '1.2.3.4:27015' }), /Код для входа \(Game ID\): ABC\nЕсли ты в той же сети/);
});

// ---- история нагрузки и журнал ----

test('история нагрузки: точка в минуту, не больше шести часов; журнал виден после остановки', async () => {
  const dataDir = tmp();
  const app = createApp({ dataDir, emit: () => {} });
  const a = await app.call('inst:create', { game: 'terraria', name: 'Т' });
  const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
  app._addHistory(a.id, { cpu: 10, memMb: 100 }, t0);
  app._addHistory(a.id, { cpu: 30, memMb: 300 }, t0 + 20000);
  app._addHistory(a.id, { cpu: 50, memMb: 200 }, t0 + 61000);
  assert.deepStrictEqual(await app.call('stats:history', { id: a.id }), [
    { t: t0, cpu: 20, mem: 300 },
    { t: t0 + 60000, cpu: 50, mem: 200 },
  ]);
  for (let k = 0; k < 400; k++) app._addHistory(a.id, { cpu: 1, memMb: 1 }, t0 + (k + 2) * 60000);
  assert.strictEqual((await app.call('stats:history', { id: a.id })).length, 360);

  const dir = path.join(dataDir, 'servers', a.id);
  fs.mkdirSync(dir, { recursive: true });
  app.runner.start(a.id, { cmd: process.execPath, args: [FAKE, '--crash'], cwd: dir, console: 'stdin', stopCmd: 'exit', readyRe: /Server started/ });
  await until(async () => (await app.call('inst:list'))[0].state === 'stopped' && (await app.call('inst:lines', { id: a.id })).length > 0);
  const lines = await app.call('inst:lines', { id: a.id });
  assert.ok(lines.some((l) => /Starting fake server/.test(l.text)), 'журнал прошлого запуска остался');
  assert.match(app.logText(a.id), /Starting fake server[\s\S]*Сервер остановлен \(код 3\)/);
  await app.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
