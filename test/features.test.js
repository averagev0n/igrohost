// Сеть, нагрузка, расписание, обновления, падения, файлы настроек, игроки, Discord.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNet, externalPorts, isCgnat, cleanTunnelAddress } = require('../lib/net');
const { createMonitor, cpuPercent } = require('../lib/monitor');
const { restartStep, warnText, localBuild, parseRemoteBuild } = require('../lib/schedule');
const { explain } = require('../lib/diagnose');
const files = require('../lib/files');
const { getGame } = require('../lib/games');
const { cmpVer, changelogNotes } = require('../lib/updater');
const { createApp } = require('../lib/app');
const { sleep } = require('../lib/util');

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

// ---- сеть ----

test('сеть: наружу открываются только игровые порты, «серый» IP распознаётся', () => {
  const ports = getGame('palworld').ports({ port: 8211 });
  assert.deepStrictEqual(externalPorts(ports), [{ port: 8211, proto: 'UDP' }]);
  assert.strictEqual(isCgnat('100.72.1.5', '95.1.2.3'), true); // адрес провайдерского NAT
  assert.strictEqual(isCgnat('95.1.2.4', '95.1.2.3'), true); // роутер видит не тот адрес, что интернет
  assert.strictEqual(isCgnat('95.1.2.3', '95.1.2.3'), false);
  assert.strictEqual(isCgnat(null, '95.1.2.3'), false);
  assert.strictEqual(cleanTunnelAddress(' HTTPS://Flower-Party.gl.joinmc.link/ '), 'flower-party.gl.joinmc.link');
  assert.strictEqual(cleanTunnelAddress('147.185.221.1:12345'), '147.185.221.1:12345');
  assert.strictEqual(cleanTunnelAddress(''), '');
  assert.throws(() => cleanTunnelAddress('не адрес'), /Адрес туннеля/);
});

test('сеть: UPnP открывает порты сервера с нужным протоколом и закрывает их', async () => {
  const calls = [];
  const fakeUpnp = {
    openPort: async (port, desc, proto) => {
      calls.push(['open', port, proto]);
      if (port === 9999) throw new Error('роутер отказал');
      return { externalIp: '95.1.2.3' };
    },
    closePort: async (port, proto) => calls.push(['close', port, proto]),
    routerIp: async () => '100.70.0.1',
  };
  const net = createNet({ dataDir: tmp(), upnpApi: fakeUpnp, fetchFn: async () => ({ ok: true, json: async () => ({ ip: '95.1.2.3' }) }) });
  const ports = getGame('sdtd').ports({ port: 26900 });
  const r = await net.openFor('a', ports, 'Сервер');
  assert.deepStrictEqual(r, { ok: true, externalIp: '95.1.2.3' });
  assert.deepStrictEqual(calls.map((c) => `${c[1]}/${c[2]}`), ['26900/TCP', '26900/UDP', '26901/UDP', '26902/UDP', '26903/UDP']); // telnet наружу не открываем
  await net.closeFor('a');
  assert.strictEqual(calls.filter((c) => c[0] === 'close').length, 5);
  const bad = await net.openFor('b', [{ port: 9999, proto: 'UDP' }], 'x');
  assert.deepStrictEqual(bad, { ok: false, error: 'роутер отказал', opened: 0 });
  const d = await net.diagnose(ports, { upnpEnabled: true });
  assert.strictEqual(d.cgnat, true);
  assert.strictEqual(d.publicIp, '95.1.2.3');
});

// ---- нагрузка ----

test('нагрузка: проценты процессора считаются от всех ядер', () => {
  assert.strictEqual(cpuPercent(null, { cpu: 0, at: 0 }, 4), null);
  // 1 секунда процессора за 1 секунду на 4 ядрах = 25%
  assert.strictEqual(cpuPercent({ cpu: 0, at: 0 }, { cpu: 10000000, at: 1000 }, 4), 25);
  assert.strictEqual(cpuPercent({ cpu: 0, at: 0 }, { cpu: 999999999, at: 1000 }, 1), 100);
});

test('нагрузка: замер настоящего процесса вместе с дочерними (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('child_process');
  // Обёртка → игра, как у серверов, запущенных через cmd или PowerShell: память должна считаться у дочернего процесса.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'game.js'), 'const a = Buffer.alloc(80 * 1024 * 1024, 1); setInterval(() => { for (let i = 0; i < 1e6; i++); }, 10);');
  fs.writeFileSync(path.join(dir, 'wrap.js'), `require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(dir, 'game.js'))}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [path.join(dir, 'wrap.js')], { windowsHide: true });
  const samples = [];
  const mon = createMonitor({ onSample: (key, s) => samples.push({ key, ...s }), everyMs: 700 });
  mon.watch('srv', child.pid);
  await until(() => samples.length >= 2, 60000); // под нагрузкой других тестов запрос к Windows идёт дольше
  mon.stop();
  require('../lib/util').killTree(child.pid);
  const s = samples[samples.length - 1];
  assert.strictEqual(s.key, 'srv');
  assert.ok(s.memMb >= 80, `память ${s.memMb} МБ — дочерний процесс не учтён`);
  assert.ok(s.cpu >= 0 && s.cpu <= 100); // под нагрузкой процесс может не получить процессор за замер — 0% тоже честно
  assert.ok(s.sysTotalMb > s.sysFreeMb);
});

// ---- расписание и обновления ----

test('расписание: предупреждения за 10, 5, 1 минуту и перезапуск — каждое один раз в день', () => {
  const done = new Set();
  const at = (h, m, s = 0) => new Date(2026, 10, 16, h, m, s);
  const steps = [];
  for (let t = at(4, 45).getTime(); t <= at(5, 5).getTime(); t += 30000) {
    const s = restartStep(new Date(t), '05:00', done);
    if (s) {
      done.add(s.key);
      steps.push(s.action === 'warn' ? `warn${s.minutes}` : 'restart');
    }
  }
  assert.deepStrictEqual(steps, ['warn10', 'warn5', 'warn1', 'restart']);
  // На следующий день — снова.
  assert.strictEqual(restartStep(new Date(2026, 10, 17, 5, 0, 10), '05:00', done).action, 'restart');
  assert.strictEqual(warnText(1), 'Сервер перезапустится через 1 минуту');
  assert.strictEqual(warnText(5), 'Сервер перезапустится через 5 минут');
});

test('обновления: номер сборки — из appmanifest и из вывода SteamCMD', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'steamapps'));
  fs.writeFileSync(path.join(dir, 'steamapps', 'appmanifest_2278520.acf'), '"AppState"\n{\n\t"appid"\t\t"2278520"\n\t"buildid"\t\t"26430253"\n}\n');
  assert.strictEqual(localBuild(dir, 2278520), '26430253');
  assert.strictEqual(localBuild(dir, 1), null);
  const out = 'AppID : 2278520, change number : 1\n"2278520"\n{\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n\t\t\t"public"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"26999999"\n\t\t\t\t"timeupdated"\t\t"1"\n\t\t\t}\n\t\t\t"beta"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"27000000"\n\t\t\t}\n\t\t}\n\t}\n}\n';
  assert.strictEqual(parseRemoteBuild(out, 2278520), '26999999');
  assert.strictEqual(parseRemoteBuild('ничего', 1), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- падения ----

test('падения: понятная причина по последним строкам журнала', () => {
  assert.strictEqual(explain(['Starting', 'System.Net.Sockets.SocketException: Only one usage of each socket address is normally permitted']).title, 'Порт занят');
  assert.strictEqual(explain([{ text: 'java.lang.OutOfMemoryError: Java heap space' }]).title, 'Не хватило памяти');
  assert.strictEqual(explain(['The code execution cannot proceed because VCRUNTIME140.dll was not found']).title, 'Не хватает компонентов Windows');
  assert.strictEqual(explain(['[Error  : BepInEx] Could not load file or assembly Jotunn']).title, 'Ошибка мода');
  assert.strictEqual(explain(['всё хорошо', 'сервер остановлен']), null);
  const own = [{ re: /особая ошибка/, title: 'Своя', advice: 'совет' }];
  assert.strictEqual(explain(['Failed to bind', 'особая ошибка'], own).title, 'Своя'); // правила игры важнее общих
});

// ---- файлы настроек ----

test('файлы настроек: только из списка игры, с копией прежней версии', () => {
  const dir = tmp();
  const v = getGame('valheim');
  const list = files.list(dir, v);
  assert.deepStrictEqual(list.map((f) => [f.path, f.exists, f.create]), [
    ['saves/adminlist.txt', false, true],
    ['saves/bannedlist.txt', false, true],
    ['saves/permittedlist.txt', false, true],
  ]);
  assert.strictEqual(files.read(dir, v, 'saves/adminlist.txt'), ''); // можно создать
  files.write(dir, v, 'saves/adminlist.txt', '76561198000000001\n', new Date(2026, 0, 1, 10, 0, 0));
  files.write(dir, v, 'saves/adminlist.txt', '76561198000000002\n', new Date(2026, 0, 1, 11, 0, 0));
  assert.strictEqual(files.read(dir, v, 'saves/adminlist.txt'), '76561198000000002\n');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'config-backups')), ['saves__adminlist.txt.2026-01-01_11-00-00']);
  assert.throws(() => files.read(dir, v, '../../panel.json'), /нельзя редактировать/);
  assert.throws(() => files.write(dir, v, 'saves/../../x.txt', 'x'), /нельзя редактировать/);
  // Файл, который создаёт сам сервер, до первого запуска не редактируется; JSON проверяется.
  const e = getGame('enshrouded');
  assert.throws(() => files.read(dir, e, 'game/enshrouded_server.json'), /после первого запуска/);
  fs.mkdirSync(path.join(dir, 'game'));
  fs.writeFileSync(path.join(dir, 'game', 'enshrouded_server.json'), '{}');
  assert.throws(() => files.write(dir, e, 'game/enshrouded_server.json', '{ сломано'), /Ошибка в JSON/);
  files.write(dir, e, 'game/enshrouded_server.json', '{"name":"x"}');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- обновление программы ----

test('обновление программы: сравнение версий и описание из CHANGELOG', () => {
  assert.strictEqual(cmpVer('0.10.0', '0.9.9'), 1);
  assert.strictEqual(cmpVer('1.0', '1.0.0'), 0);
  assert.strictEqual(cmpVer('0.2.0', '0.2.1'), -1);
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.match(changelogNotes(text, '0.2.0'), /UPnP/);
  assert.ok(!/Первая версия/.test(changelogNotes(text, '0.2.0')));
  assert.match(changelogNotes(text, '0.1.0'), /Первая версия/);
});

// ---- панель целиком ----

test('панель: игроки, сообщение всем, перезапуск по расписанию, причина падения, настройки сети и Discord', async () => {
  const dataDir = tmp();
  const events = [];
  const app = createApp({ dataDir, emit: (ch, p) => events.push({ ch, p }), fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const a = await app.call('inst:create', { game: 'terraria', name: 'Тест' });
  const dir = path.join(dataDir, 'servers', a.id);
  const spec = (args = []) => ({ cmd: process.execPath, args: [FAKE, ...args], cwd: dir, console: 'stdin', stopCmd: 'exit', readyRe: /Server started/, joinRe: /^(.{1,40}) has joined\.$/, leaveRe: /^(.{1,40}) has left\.$/ });

  // Игроки и действия над ними.
  app.runner.start(a.id, spec());
  await until(async () => (await app.call('inst:list'))[0].state === 'running');
  await app.call('inst:command', { id: a.id, text: 'join Вася' });
  await until(async () => (await app.call('inst:list'))[0].players.length === 1);
  const v = (await app.call('inst:list'))[0];
  assert.deepStrictEqual(v.playerActions, ['kick', 'ban']);
  assert.strictEqual(v.canSay, true);
  await app.call('players:action', { id: a.id, name: 'Вася', action: 'kick' });
  await app.call('players:say', { id: a.id, text: 'Всем привет' });
  await until(async () => (await app.call('inst:lines', { id: a.id })).some((l) => l.text === 'echo: say Всем привет'));
  assert.ok((await app.call('inst:lines', { id: a.id })).some((l) => l.text === 'echo: kick Вася'));
  await assert.rejects(app.call('players:action', { id: a.id, name: 'Вася', action: 'admin' }), /недоступно/);

  // Перезапуск по расписанию: предупреждение, затем перезапуск.
  await app.call('inst:update', { id: a.id, maint: { restartEnabled: true, restartTime: '05:00' } });
  await assert.rejects(app.call('inst:update', { id: a.id, maint: { restartTime: '25:00' } }), /ЧЧ:ММ/);
  app._restartTick(new Date(2026, 10, 16, 4, 55, 0));
  await until(async () => (await app.call('inst:lines', { id: a.id })).some((l) => l.text === 'echo: say Сервер перезапустится через 5 минут'));
  const startedBefore = (await app.call('inst:list'))[0].startedAt;
  // Перезапуск идёт через настоящий start(): подменяем запуск игры поддельным сервером.
  const game = getGame('terraria');
  const origLaunch = game.launch;
  const origExe = game.exe;
  game.launch = () => spec(['--crash']);
  game.exe = () => FAKE;
  try {
    app._restartTick(new Date(2026, 10, 16, 5, 0, 10));
    await until(async () => (await app.call('inst:list'))[0].startedAt > startedBefore, 10000);
    // Поддельный сервер с --crash падает через 150 мс: панель объяснит падение, если найдёт причину.
    await until(async () => (await app.call('inst:list'))[0].lastCrash, 10000);
    const crashed = (await app.call('inst:list'))[0];
    assert.strictEqual(crashed.lastCrash.code, 3);
    assert.strictEqual(crashed.lastCrash.early, true);
    assert.ok(events.some((e) => e.ch === 'toast' && /неожиданно остановился/.test(e.p.text)));
  } finally {
    game.launch = origLaunch;
    game.exe = origExe;
  }

  // Настройки сети и Discord.
  const n = await app.call('net:set', { id: a.id, upnp: true, tunnel: 'party.gl.joinmc.link', tunnelAuto: true });
  assert.deepStrictEqual(n, { upnp: true, tunnel: 'party.gl.joinmc.link', tunnelAuto: true });
  await assert.rejects(app.call('net:set', { id: a.id, tunnel: 'плохой адрес' }), /Адрес туннеля/);
  await assert.rejects(app.call('dc:set', { url: 'https://example.com/hook' }), /вебхука Discord/);
  const dc = await app.call('dc:set', { url: 'https://discord.com/api/webhooks/123/abc-DEF', events: { backup: true } });
  assert.strictEqual(dc.url, 'https://discord.com/api/webhooks/123/abc-DEF');
  assert.strictEqual(dc.events.backup, true);
  assert.strictEqual(dc.events.crash, true);

  // Файлы настроек через API.
  const fl = await app.call('files:list', { id: a.id });
  assert.strictEqual(fl[0].path, 'tshock/tshock/config.json');

  // Дополнительные команды от окна программы.
  app.extend({ 'update:state': () => ({ status: 'none' }) });
  assert.deepStrictEqual(await app.call('update:state'), { status: 'none' });

  await app.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
