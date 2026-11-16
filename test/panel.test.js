const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mods = require('../lib/mods');
const { getGame } = require('../lib/games');
const { createBot, statusText, pickServer } = require('../lib/tgbot');
const { createApp } = require('../lib/app');
const { createHttp } = require('../lib/http');
const { run, TAR, sleep } = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));
const FAKE = path.join(__dirname, 'fake-server.js');

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('не дождались условия');
}

async function makeZip(files) {
  const src = tmp();
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, name), text);
  }
  const zip = path.join(tmp(), 'mod.zip');
  const r = await run(TAR, ['-a', '-cf', zip, '-C', src, ...fs.readdirSync(src)]);
  assert.strictEqual(r.code, 0, r.out);
  return zip;
}

// ---- моды ----

test('Thunderstore: файлы мода раскладываются по папкам BepInEx', () => {
  const plan = (files) => Object.fromEntries(mods.planThunderstore(files, 'Автор-Мод', 'BepInExPack_Valheim').map((x) => [x.from, x.to]));
  assert.deepStrictEqual(plan(['manifest.json', 'Mod.dll', 'plugins/Sub/A.dll', 'config/mod.cfg', 'BepInEx/patchers/P.dll', 'Translations/ru.json']), {
    'manifest.json': 'BepInEx/plugins/Автор-Мод/manifest.json',
    'Mod.dll': 'BepInEx/plugins/Автор-Мод/Mod.dll',
    'plugins/Sub/A.dll': 'BepInEx/plugins/Автор-Мод/Sub/A.dll',
    'config/mod.cfg': 'BepInEx/config/mod.cfg',
    'BepInEx/patchers/P.dll': 'BepInEx/patchers/Автор-Мод/P.dll',
    'Translations/ru.json': 'BepInEx/plugins/Автор-Мод/Translations/ru.json',
  });
  // Сам загрузчик кладётся в корень игры, служебные файлы архива — нет.
  assert.deepStrictEqual(plan(['manifest.json', 'BepInExPack_Valheim/winhttp.dll', 'BepInExPack_Valheim/BepInEx/core/BepInEx.dll']), {
    'BepInExPack_Valheim/winhttp.dll': 'winhttp.dll',
    'BepInExPack_Valheim/BepInEx/core/BepInEx.dll': 'BepInEx/core/BepInEx.dll',
  });
});

test('моды из файла: одиночный файл, архив, выключение и удаление', async () => {
  const dir = tmp();
  const rust = getGame('rust');
  const src = path.join(tmp(), 'Kits.cs');
  fs.writeFileSync(src, '// plugin');
  await mods.addFile({ dir, game: rust, folderId: 'plugins', fileName: 'Kits.cs', filePath: src });
  await assert.rejects(mods.addFile({ dir, game: rust, folderId: 'plugins', fileName: 'virus.exe', filePath: src }), /подходят файлы/);
  await assert.rejects(mods.addFile({ dir, game: rust, folderId: 'нет', fileName: 'Kits.cs', filePath: src }), /Неизвестная папка/);
  const zip = await makeZip({ 'inner/Backpacks.cs': '//', 'readme.txt': 'x' });
  await mods.addFile({ dir, game: rust, folderId: 'plugins', fileName: 'pack.zip', filePath: zip });

  let f = mods.folders(dir, rust)[0];
  assert.deepStrictEqual(f.items.map((i) => i.name), ['Backpacks.cs', 'Kits.cs']);
  assert.strictEqual(f.needs, 'Oxide (uMod)'); // загрузчик ещё не стоит
  assert.deepStrictEqual(f.accept, ['.cs', '.zip']);

  mods.toggleItem(dir, rust, 'plugins', 'Kits.cs');
  f = mods.folders(dir, rust)[0];
  assert.deepStrictEqual(f.items.map((i) => [i.name, i.enabled]), [['Backpacks.cs', true], ['Kits.cs.disabled', false]]);
  mods.toggleItem(dir, rust, 'plugins', 'Kits.cs.disabled');
  mods.removeItem(dir, rust, 'plugins', 'Kits.cs');
  assert.throws(() => mods.removeItem(dir, rust, 'plugins', '..\\..\\panel.json'), /не найден/);
  assert.deepStrictEqual(mods.folders(dir, rust)[0].items.map((i) => i.name), ['Backpacks.cs']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CS2: архив плагина кладётся папкой, архив «от корня игры» — как есть', async () => {
  const dir = tmp();
  const cs2 = getGame('cs2');
  const a = await makeZip({ 'MyPlugin/MyPlugin.dll': 'x', 'MyPlugin/lang/ru.json': '{}' });
  await mods.addFile({ dir, game: cs2, folderId: 'plugins', fileName: 'MyPlugin-1.0.zip', filePath: a });
  const b = await makeZip({ 'addons/counterstrikesharp/plugins/Other/Other.dll': 'x', 'addons/counterstrikesharp/configs/plugins/Other/Other.json': '{}' });
  await mods.addFile({ dir, game: cs2, folderId: 'plugins', fileName: 'Other.zip', filePath: b });
  const c = await makeZip({ 'Flat.dll': 'x', 'Flat.deps.json': '{}' });
  await mods.addFile({ dir, game: cs2, folderId: 'plugins', fileName: 'Flat.zip', filePath: c });
  const items = mods.folders(dir, cs2)[0].items;
  assert.deepStrictEqual(items.map((i) => i.name), ['Flat', 'MyPlugin', 'Other']);
  assert.ok(items.every((i) => i.dir));
  assert.ok(fs.existsSync(path.join(dir, 'game/game/csgo/addons/counterstrikesharp/configs/plugins/Other/Other.json')));
  assert.throws(() => mods.toggleItem(dir, cs2, 'plugins', 'Flat'), /только удалить/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('служебные моды загрузчика в списке не показываются', () => {
  const dir = tmp();
  const base = path.join(dir, 'tshock', 'ServerPlugins');
  fs.mkdirSync(base, { recursive: true });
  for (const n of ['TShockAPI.dll', 'OTAPI.Runtime.dll', 'MyPlugin.dll', 'notes.txt']) fs.writeFileSync(path.join(base, n), '');
  assert.deepStrictEqual(mods.folders(dir, getGame('terraria'))[0].items.map((i) => i.name), ['MyPlugin.dll']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Telegram ----

function botHarness(list) {
  const sent = [];
  const calls = [];
  const state = { chatId: null, control: true };
  const bot = createBot({
    cfg: () => state,
    code: () => '123456',
    link: (chatId) => (state.chatId = chatId),
    send: async (chatId, text) => sent.push({ chatId, text }),
    actions: {
      list: () => list,
      start: async (id) => calls.push(['start', id]),
      stop: async (id) => calls.push(['stop', id]),
      restart: async (id) => calls.push(['restart', id]),
      backup: async (id) => calls.push(['backup', id]),
      command: async (id, text) => {
        calls.push(['command', id, text]);
        if (text === 'сломайся') throw new Error('Сервер не запущен');
        return 'ok';
      },
    },
  });
  const say = (text, chat = 1) => bot.onMessage({ text, chat: { id: chat, first_name: 'Я' } });
  return { say, sent, calls, state };
}

const TWO = [
  { id: 'a', gameTitle: 'Valheim', name: 'Север', state: 'running', startedAt: Date.now() - 65 * 60000, players: ['Вася'] },
  { id: 'b', gameTitle: 'Terraria', name: 'Мир', state: 'stopped', players: [] },
];

test('бот: чат привязывается только по верному коду, чужие чаты игнорируются', async () => {
  const h = botHarness(TWO);
  await h.say('/status');
  await h.say('/start 000000');
  assert.strictEqual(h.sent.length, 0);
  assert.strictEqual(h.state.chatId, null);
  await h.say('/start 123456');
  assert.strictEqual(h.state.chatId, 1);
  assert.match(h.sent[0].text, /привязана/);
  await h.say('/off 1', 999);
  assert.strictEqual(h.calls.length, 0);
});

test('бот: команды с номером сервера', async () => {
  const h = botHarness(TWO);
  h.state.chatId = 1;
  await h.say('/status');
  assert.match(h.sent.pop().text, /1\. 🟢 Valheim «Север» — работает 1 ч 5 мин, игроки: Вася\n2\. ⚪ Terraria «Мир» — выключен/);
  await h.say('/on 2');
  await h.say('/off@MyBot 1');
  await h.say('/restart 1');
  await h.say('/backup 1');
  await h.say('/cmd 1 say Всем привет');
  assert.deepStrictEqual(h.calls, [['start', 'b'], ['stop', 'a'], ['restart', 'a'], ['backup', 'a'], ['command', 'a', 'say Всем привет']]);
  await h.say('/on');
  assert.match(h.sent.pop().text, /Укажите номер/);
  await h.say('/on 7');
  assert.match(h.sent.pop().text, /№7 нет/);
  await h.say('/cmd 1 сломайся');
  assert.match(h.sent.pop().text, /Не получилось: Сервер не запущен/);
  h.state.control = false;
  await h.say('/off 1');
  assert.match(h.sent.pop().text, /выключено/);
});

test('бот: с одним сервером номер не нужен', () => {
  assert.deepStrictEqual(pickServer([TWO[0]], 'say привет'), { server: TWO[0], rest: 'say привет' });
  assert.deepStrictEqual(pickServer([TWO[0]], ''), { server: TWO[0], rest: '' });
  assert.match(statusText([]), /пока нет/);
});

// ---- панель целиком ----

test('панель: создание серверов, порты, настройки, запуск, копия, удаление', async () => {
  const dataDir = tmp();
  const events = [];
  const app = createApp({ dataDir, emit: (ch, p) => events.push({ ch, p }), fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const info = await app.call('app:info');
  assert.strictEqual(info.games.length, 8);

  const a = await app.call('inst:create', { game: 'terraria', name: 'Первый', settings: { worldname: 'Мир' } });
  const b = await app.call('inst:create', { game: 'terraria', name: '' });
  assert.strictEqual(a.settings.port, 7777);
  assert.strictEqual(b.settings.port, 7787); // порт подвинулся сам
  assert.strictEqual(b.name, 'Terraria');
  await assert.rejects(app.call('inst:create', { game: 'terraria', settings: { port: 7787 } }), /порт уже занят/);
  await assert.rejects(app.call('inst:update', { id: b.id, settings: { port: 7777 } }), /порт уже занят/);
  await assert.rejects(app.call('inst:create', { game: 'doom' }), /Неизвестная игра/);
  await assert.rejects(app.call('inst:start', { id: a.id }), /Сначала установите/);
  await assert.rejects(app.call('mods:framework', { id: a.id, fw: 'tshock' }), /Сначала установите/);

  const up = await app.call('inst:update', { id: a.id, name: 'Главный', settings: { maxplayers: 16 }, maint: { backupEveryHours: 6, backupKeep: 3 } });
  assert.strictEqual(up.name, 'Главный');
  assert.strictEqual(up.settings.maxplayers, 16);
  assert.strictEqual(up.settings.worldname, 'Мир'); // остальные настройки не сбросились
  assert.strictEqual(up.maint.backupEveryHours, 6);
  await assert.rejects(app.call('inst:update', { id: a.id, maint: { backupEveryHours: 5 } }), /интервал/);

  // Подменяем «игру» поддельным сервером: кладём исполняемый файл и запускаем через runner напрямую.
  const dir = path.join(dataDir, 'servers', a.id);
  fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game', 'TerrariaServer.exe'), '');
  assert.strictEqual((await app.call('inst:list'))[0].installed, true);
  app.runner.start(a.id, { cmd: process.execPath, args: [FAKE, '--world', path.join(dir, 'worlds')], cwd: dir, console: 'stdin', stopCmd: 'exit', readyRe: /Server started/ });
  await until(async () => (await app.call('inst:list'))[0].state === 'running');
  await assert.rejects(app.call('inst:delete', { id: a.id }), /остановите/);
  await assert.rejects(app.call('mods:remove', { id: a.id, folder: 'plugins', name: 'x.dll' }), /остановите сервер/);
  await app.call('inst:command', { id: a.id, text: 'hello' });
  await until(async () => (await app.call('inst:lines', { id: a.id })).some((l) => l.text === 'echo: hello'));

  await app.call('backup:create', { id: a.id });
  const list = await app.call('backup:list', { id: a.id });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].reason, 'вручную');
  await assert.rejects(app.call('backup:restore', { id: a.id, name: list[0].name }), /остановите/);

  await app.call('inst:stop', { id: a.id });
  await until(async () => (await app.call('inst:list'))[0].state === 'stopped');
  fs.writeFileSync(path.join(dir, 'worlds', 'world.wld'), 'испорчен');
  await app.call('backup:restore', { id: a.id, name: list[0].name });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'worlds', 'world.wld'), 'utf8'), 'v1');
  assert.strictEqual((await app.call('backup:list', { id: a.id })).length, 2); // добавилась копия «перед восстановлением»

  const m = await app.call('mods:get', { id: a.id });
  assert.deepStrictEqual(m.frameworks.map((f) => [f.id, f.installed]), [['tshock', false]]);

  await app.call('inst:delete', { id: a.id });
  assert.ok(!fs.existsSync(dir));
  assert.strictEqual((await app.call('inst:list')).length, 1);
  assert.ok(events.some((e) => e.ch === 'instances') && events.some((e) => e.ch === 'log') && events.some((e) => e.ch === 'backups'));

  // Настройки пережили перезапуск панели, ключ доступа тот же.
  const again = createApp({ dataDir });
  assert.strictEqual((await again.call('inst:list'))[0].id, b.id);
  assert.strictEqual(again.token, app.token);
  assert.strictEqual((await again.call('tg:get')).connected, false);
  await assert.rejects(again.call('tg:connect', { token: 'мусор' }), /не похоже на токен/);
  await app.shutdown();
  await again.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- веб-сервер ----

test('веб: без ключа не пускает, чужой сайт и чужой адрес отклоняются', async () => {
  const token = 'a'.repeat(48);
  const web = createHttp({ app: { call: async (m, a) => ({ m, a }), upload: async (u) => ({ name: u.name, size: fs.statSync(u.filePath).size }) }, staticDir: path.join(__dirname, '..', 'renderer'), token });
  const port = await web.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const cookie = `igrohost=${token}`;

  assert.strictEqual((await fetch(base + '/')).status, 401);
  assert.strictEqual((await fetch(base + '/?t=' + 'b'.repeat(48), { redirect: 'manual' })).status, 403);
  const login = await fetch(base + '/?t=' + token, { redirect: 'manual' });
  assert.strictEqual(login.status, 302);
  assert.match(login.headers.get('set-cookie'), /igrohost=a+; HttpOnly; SameSite=Strict/);

  const page = await fetch(base + '/', { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);

  const call = (headers) => fetch(base + '/api/call', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method: 'x', arg: { n: 1 } }) });
  assert.strictEqual((await call({})).status, 401);
  assert.deepStrictEqual(await (await call({ cookie })).json(), { ok: true, data: { m: 'x', a: { n: 1 } } });
  assert.strictEqual((await call({ cookie, origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await fetch(base + '/api/call', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.strictEqual((await fetch(base + '/..%2Fpackage.json', { headers: { cookie } })).status, 404);

  const up = await fetch(base + '/api/upload?id=1&folder=plugins&name=a.cs', { method: 'POST', headers: { cookie }, body: Buffer.from('12345') });
  assert.deepStrictEqual(await up.json(), { ok: true, data: { name: 'a.cs', size: 5 } });
  web.close();
});
