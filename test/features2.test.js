// Перенос миров, телефон, сон, сообщения, вторая папка для копий, отчёт, обновление модов, новые игры.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const worlds = require('../lib/worlds');
const { createHttp, isLanAddress } = require('../lib/http');
const { weekKey, reportDue, reportText } = require('../lib/report');
const mods = require('../lib/mods');
const { getGame, cleanSettings } = require('../lib/games');
const { createApp } = require('../lib/app');
const { sleep } = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));
const FAKE = path.join(__dirname, 'fake-server.js');
const put = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('не дождались условия');
}

// ---- миры из одиночной игры ----

test('миры: Valheim, Terraria и Core Keeper находятся и переносятся на сервер', async () => {
  const home = tmp();
  const docs = path.join(home, 'Docs');
  const vh = path.join(home, 'AppData', 'LocalLow', 'IronGate', 'Valheim', 'worlds_local');
  put(path.join(vh, 'Север.fwl'), 'meta');
  put(path.join(vh, 'Север.db'), 'world-data');
  put(path.join(vh, 'Битый.fwl'), 'нет .db — не показываем');
  put(path.join(docs, 'My Games', 'Terraria', 'Worlds', 'Остров.wld'), 'terraria-world');
  put(path.join(home, 'AppData', 'LocalLow', 'Pugstorm', 'Core Keeper', 'Steam', '7656', 'worlds', '2.world.gzip'), 'ck');
  const opts = { home, docs };

  const v = await worlds.list('valheim', opts);
  assert.deepStrictEqual(v.map((w) => w.name), ['Север']);
  const dir = tmp();
  const patch = await worlds.importWorld('valheim', dir, v[0].key, {}, opts);
  assert.deepStrictEqual(patch, { world: 'Север' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'saves', 'worlds_local', 'Север.db'), 'utf8'), 'world-data');

  const t = await worlds.list('terraria', opts);
  assert.deepStrictEqual(await worlds.importWorld('terraria', dir, t[0].key, {}, opts), { worldname: 'Остров' });
  assert.ok(fs.existsSync(path.join(dir, 'worlds', 'Остров.wld')));

  const c = await worlds.list('corekeeper', opts);
  assert.strictEqual(c[0].name, 'Мир №3');
  await worlds.importWorld('corekeeper', dir, c[0].key, { world: 1 }, opts);
  assert.ok(fs.existsSync(path.join(dir, 'saves', 'worlds', '1.world.gzip')));

  // Путь не из списка — отказ: так нельзя скопировать произвольный файл.
  await assert.rejects(worlds.importWorld('terraria', dir, path.join(home, 'secret.wld'), {}, opts), /не найден/);
  assert.deepStrictEqual(await worlds.list('rust', opts), []);
  assert.strictEqual(worlds.supported('valheim'), true);
  assert.strictEqual(worlds.supported('cs2'), false);
});

// ---- вход с телефона ----

test('телефон: только домашняя сеть, ПИН-код, блокировка после пяти ошибок, без смены настроек доступа', async () => {
  assert.ok(isLanAddress('192.168.1.5') && isLanAddress('::ffff:10.0.0.2') && isLanAddress('172.20.1.1') && isLanAddress('127.0.0.1'));
  assert.ok(!isLanAddress('95.1.2.3') && !isLanAddress('172.32.0.1') && !isLanAddress('::ffff:8.8.8.8'));

  let clock = 1000000;
  const sessions = [];
  const calls = [];
  const web = createHttp({
    app: { call: async (m) => (calls.push(m), { m }), backupFile: () => { throw new Error('Копия не найдена'); } },
    staticDir: path.join(__dirname, '..', 'renderer'),
    token: 'a'.repeat(48),
    remote: { pin: () => '123456', hasSession: (h) => sessions.includes(h), addSession: (h) => sessions.push(h) },
    now: () => clock,
  });
  const port = await web.listenRemote(0);
  const base = `http://127.0.0.1:${port}`;
  const login = (pin) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });

  // Без входа: страница перенаправляет на вход, API отвечает 401, страница входа доступна.
  assert.strictEqual((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), '/login.html');
  assert.strictEqual((await fetch(base + '/api/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.strictEqual((await fetch(base + '/login.html')).status, 200);
  assert.strictEqual((await fetch(base + '/app.js', { redirect: 'manual' })).status, 302);

  for (let i = 0; i < 4; i++) assert.strictEqual((await login('000000')).status, 403);
  const fifth = await login('000000');
  assert.match((await fifth.json()).error, /Слишком много попыток/);
  assert.strictEqual((await login('123456')).status, 429); // даже верный ПИН — после блокировки
  clock += 11 * 60000;
  const ok = await login('123456');
  assert.strictEqual(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^igrphone=[a-f0-9]{64}$/);
  assert.strictEqual(sessions.length, 1);
  assert.notStrictEqual(sessions[0], cookie.split('=')[1]); // храним только отпечаток

  const call = (method) => fetch(base + '/api/call', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ method }) }).then((r) => r.json());
  assert.deepStrictEqual(await call('inst:list'), { ok: true, data: { m: 'inst:list' } });
  assert.match((await call('remote:newPin')).error, /только на компьютере/);
  assert.match((await call('app:prefs')).error, /только на компьютере/);
  assert.ok(!calls.includes('remote:newPin'));
  // Местный вход по-прежнему не открывается с этого порта по ключу.
  assert.strictEqual((await fetch(base + '/?t=' + 'a'.repeat(48), { redirect: 'manual' })).status, 302);
  web.close();
});

// ---- отчёт за неделю ----

test('отчёт: неделя, срок отправки, текст', () => {
  assert.strictEqual(weekKey(new Date(2026, 10, 18, 12)), '2026-11-16'); // среда → понедельник
  assert.strictEqual(weekKey(new Date(2026, 10, 22, 23)), '2026-11-16'); // воскресенье → тот же понедельник
  assert.strictEqual(reportDue(new Date(2026, 10, 16, 9, 59), null), false);
  assert.strictEqual(reportDue(new Date(2026, 10, 16, 10, 1), null), true);
  assert.strictEqual(reportDue(new Date(2026, 10, 16, 15), '2026-11-16'), false);
  const text = reportText([
    { title: 'Valheim «Север»', week: { uptimeMs: 3 * 3600000 + 20 * 60000, starts: 2, crashes: 1, backups: 4, players: { Вася: 7200000, Катя: 1800000 } } },
    { title: 'Rust «Пусто»', week: { uptimeMs: 0, starts: 0, crashes: 0, backups: 0, players: {} } },
  ]);
  assert.match(text, /Valheim «Север»\nРаботал: 3 ч 20 мин, запусков: 2\nИграли: Вася — 2 ч, Катя — 30 мин\nКопий: 4\nПадений: 1/);
  assert.ok(!text.includes('Пусто'));
  assert.strictEqual(reportText([{ title: 'x', week: { uptimeMs: 0, starts: 0, players: {} } }]), '');
});

// ---- обновление модов ----

test('моды: версии сравниваются, из плагина uMod берётся версия, обновления находятся', async () => {
  assert.strictEqual(mods.cmpVersion('1.10.0', '1.9.9'), 1);
  assert.strictEqual(mods.cmpVersion('v2.0', '2.0.0'), 0);
  assert.deepStrictEqual(mods.umodInfo('[Info("Rust Kits", "k1lly0u", "4.4.9")]\nclass Kits {}'), { title: 'Rust Kits', author: 'k1lly0u', version: '4.4.9' });

  const dir = tmp();
  put(path.join(dir, 'game', 'oxide', 'plugins', 'Kits.cs'), '[Info("Rust Kits", "k1lly0u", "4.4.9")]');
  put(path.join(dir, 'game', 'oxide', 'plugins', 'Fresh.cs'), '[Info("Fresh", "me", "1.0.0")]');
  const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes('Rust%20Kits')) return { data: [{ download_url: 'https://umod.org/plugins/Kits.cs', latest_release_version: '4.4.10' }] };
      if (url.includes('Fresh')) return { data: [{ download_url: 'https://umod.org/plugins/Fresh.cs', latest_release_version: '1.0.0' }] };
      if (url.includes('thunderstore')) return { latest: { version_number: url.includes('Old') ? '2.1.0' : '1.0.0' } };
      return {};
    },
  });
  assert.deepStrictEqual(await mods.checkUpdates({ dir, game: getGame('rust'), fetchFn: fakeFetch }), [{ id: 'Kits.cs', title: 'Rust Kits', current: '4.4.9', latest: '4.4.10' }]);

  put(path.join(dir, 'game', 'BepInEx', 'plugins', 'Author-Old', 'manifest.json'), JSON.stringify({ version_number: '2.0.3' }));
  put(path.join(dir, 'game', 'BepInEx', 'plugins', 'Author-New', 'manifest.json'), JSON.stringify({ version_number: '1.0.0' }));
  assert.deepStrictEqual(await mods.checkUpdates({ dir, game: getGame('valheim'), fetchFn: fakeFetch }), [{ id: 'Author/Old', title: 'Old', current: '2.0.3', latest: '2.1.0' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- новые игры ----

test('новые игры: аргументы запуска и настройки', () => {
  const dir = tmp();
  const tf2 = getGame('tf2');
  const a = tf2.launch({ dir, s: cleanSettings(tf2, { hostname: 'Мой TF2', rconPassword: 'pw', password: 'x', gslt: 'ABC' }) });
  assert.ok(a.cmd.endsWith(path.join('game', 'srcds.exe')));
  assert.strictEqual(a.args[a.args.indexOf('-game') + 1], 'tf');
  assert.strictEqual(a.args[a.args.length - 3 - 2], 'cp_dustbowl'); // +map, затем пароль и токен
  assert.ok(a.args.includes('+sv_setsteamaccount') && a.logFile.endsWith(path.join('tf', 'console.log')));
  assert.match('Client "Вася" connected (1.2.3.4:27005).', tf2.joinRe);
  assert.match('Вася connected', tf2.joinRe);
  assert.doesNotMatch('Connection to Steam servers successful.', tf2.joinRe);

  const l4d2 = getGame('l4d2');
  const b = l4d2.launch({ dir, s: cleanSettings(l4d2, { mode: 'versus', rconPassword: 'pw' }) });
  assert.strictEqual(b.args[b.args.indexOf('+mp_gamemode') + 1], 'versus');
  assert.strictEqual(b.args[b.args.indexOf('+sv_allow_lobby_connect_only') + 1], '0');
  assert.throws(() => cleanSettings(getGame('gmod'), { gamemode: 'Bad Mode' }), /недопустимые/);

  const vr = getGame('vrising');
  fs.mkdirSync(path.join(dir, 'game', 'VRisingServer_Data', 'StreamingAssets', 'Settings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game', 'VRisingServer_Data', 'StreamingAssets', 'Settings', 'ServerHostSettings.json'), JSON.stringify({ Name: 'x', ServerFps: 30, Rcon: { Enabled: false, Port: 25575 } }));
  const c = vr.launch({ dir, s: cleanSettings(vr, { name: 'Вампиры', rconPassword: 'r', port: 9876 }) });
  const host = JSON.parse(fs.readFileSync(path.join(dir, 'save-data', 'Settings', 'ServerHostSettings.json'), 'utf8'));
  assert.strictEqual(host.Name, 'Вампиры');
  assert.strictEqual(host.ServerFps, 30); // ключи образца сохранились
  assert.deepStrictEqual(host.Rcon, { Enabled: true, Port: 9878, Password: 'r' });
  assert.strictEqual(host.QueryPort, 9877);
  assert.ok(c.ctrlC && c.args.includes('-persistentDataPath'));
  assert.deepStrictEqual(vr.link(cleanSettings(vr, { rconPassword: 'r' })), { type: 'rcon', port: 9878, password: 'r' });

  const ck = getGame('corekeeper');
  const d = ck.launch({ dir, s: cleanSettings(ck, { worldName: 'Пещеры', gameId: '' }) });
  assert.strictEqual(d.args[d.args.indexOf('-datapath') + 1], path.join(dir, 'saves'));
  assert.ok(!d.args.includes('-gameid'));
  assert.throws(() => cleanSettings(ck, { gameId: 'короткий' }), /Game ID/);
  assert.strictEqual(ck.joinCode(dir), null);
  put(path.join(dir, 'game', 'GameID.txt'), 'AbCdEfGhJkLmNoPqRsTuVwZ1234567\n');
  assert.strictEqual(ck.joinCode(dir), 'AbCdEfGhJkLmNoPqRsTuVwZ1234567');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- панель целиком ----

test('панель: сон без игроков, сообщения, вторая папка для копий, скачивание копии, отчёт', async () => {
  const dataDir = tmp();
  const mirror = tmp();
  const app = createApp({ dataDir, emit: () => {}, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const a = await app.call('inst:create', { game: 'terraria', name: 'Тест' });
  const dir = path.join(dataDir, 'servers', a.id);
  fs.mkdirSync(path.join(dir, 'worlds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worlds', 'w.wld'), 'мир');

  await assert.rejects(app.call('inst:update', { id: a.id, maint: { mirror: 'не путь' } }), /полный путь/);
  await assert.rejects(app.call('inst:update', { id: a.id, maint: { mirror: path.join(dataDir, 'x') } }), /вне папки/);
  await assert.rejects(app.call('inst:update', { id: a.id, maint: { messages: [{ every: 1, text: 'часто' }] } }), /от 5 до 1440/);
  const v = await app.call('inst:update', {
    id: a.id,
    maint: { mirror, sleepMinutes: 10, welcome: 'Привет, {name}!', messages: [{ every: 30, text: 'Правила — в Discord' }], autostart: true },
  });
  assert.strictEqual(v.maint.sleepMinutes, 10);
  assert.strictEqual(v.canSleep, true);

  // Сон доступен только там, где вход игроков проверен.
  const vh = await app.call('inst:create', { game: 'valheim', name: 'В' });
  await assert.rejects(app.call('inst:update', { id: vh.id, maint: { sleepMinutes: 10 } }), /сон выключен/);

  // Копия попадает и во вторую папку; её можно скачать.
  const name = await app.call('backup:create', { id: a.id });
  const copies = fs.readdirSync(mirror).flatMap((d) => fs.readdirSync(path.join(mirror, d)));
  assert.deepStrictEqual(copies, [name]);
  assert.strictEqual(app.backupFile(a.id, name), path.join(dir, 'backups', name));
  assert.throws(() => app.backupFile(a.id, '../../panel.json'), /не найдена/);

  // Запуск, игрок, сообщения, сон.
  app.runner.start(a.id, { cmd: process.execPath, args: [FAKE], cwd: dir, console: 'stdin', stopCmd: 'exit', readyRe: /Server started/, joinRe: /^(.{1,40}) has joined\.$/, leaveRe: /^(.{1,40}) has left\.$/ });
  await until(async () => (await app.call('inst:list'))[0].state === 'running');
  await app.call('inst:command', { id: a.id, text: 'join Вася' });
  await until(async () => (await app.call('inst:list'))[0].players.length === 1);
  app._messagesTick(Date.now() + 31 * 60000);
  await until(async () => (await app.call('inst:lines', { id: a.id })).some((l) => l.text === 'echo: say Правила — в Discord'));
  app._sleepTick(Date.now() + 60 * 60000);
  await sleep(200);
  assert.strictEqual((await app.call('inst:list'))[0].state, 'running'); // игрок на сервере — не спим
  await app.call('inst:command', { id: a.id, text: 'leave Вася' });
  await until(async () => (await app.call('inst:list'))[0].players.length === 0);
  app._sleepTick(Date.now() + 11 * 60000);
  await until(async () => (await app.call('inst:list'))[0].state === 'stopped');
  const slept = (await app.call('inst:list'))[0];
  assert.strictEqual(slept.asleep, true);

  // Отчёт: время работы и игрок попали в недельную статистику.
  const report = app._weeklyReport();
  assert.match(report, /Terraria «Тест»\nРаботал: \d+ мин, запусков: 0/);
  assert.match(report, /Играли: Вася/);
  assert.match(report, /Копий: 1/);

  await app.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(mirror, { recursive: true, force: true });
});
