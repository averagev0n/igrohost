// Project Zomboid, 7 Days to Die, Enshrouded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { getGame, cleanSettings, portsOf, freePorts } = require('../lib/games');
const { telnet, telnetReply } = require('../lib/rcon');
const { createRunner } = require('../lib/runner');
const { sleep } = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));

// Так выглядит StartServer64.bat из сервера Project Zomboid (сокращён список библиотек).
const PZ_BAT = [
  '@setlocal enableextensions',
  '@cd /d "%~dp0"',
  'SET PZ_CLASSPATH=java/istack-commons-runtime.jar;java/jassimp.jar;java/',
  '".\\jre64\\bin\\java.exe" -Djava.awt.headless=true -Dzomboid.steam=1 -Dzomboid.znetlog=1 -XX:+UseZGC -XX:-CreateCoredumpOnCrash -XX:-OmitStackTraceInFastThrow -Xms16g -Xmx16g -Djava.library.path=natives/;natives/win64/;. -cp %PZ_CLASSPATH% zombie.network.GameServer -statistic 0 %1 %2',
  'PAUSE',
  '',
].join('\r\n');

test('Project Zomboid: java запускается напрямую, со своей памятью и без %1 %2', () => {
  const pz = getGame('zomboid');
  const parsed = pz.parseStartBat(PZ_BAT);
  assert.strictEqual(parsed.java, '.\\jre64\\bin\\java.exe');
  const args = pz.javaArgs(parsed, 6);
  assert.ok(!args.includes('-Xms16g') && !args.includes('-Xmx16g'));
  assert.ok(!args.some((a) => /^%/.test(a)));
  assert.strictEqual(args[args.indexOf('-cp') + 1], 'java/istack-commons-runtime.jar;java/jassimp.jar;java/');
  const main = args.indexOf('zombie.network.GameServer');
  assert.ok(args.indexOf('-Xmx6g') < main && args.indexOf('-Xms2g') < main && args.indexOf('-Dfile.encoding=UTF-8') < main);
  assert.deepStrictEqual(args.slice(main), ['zombie.network.GameServer', '-statistic', '0']);
  assert.strictEqual(pz.parseStartBat('echo hello'), null);
});

test('Project Zomboid: ini дополняется, чужие строки остаются', () => {
  const { setIni } = getGame('zomboid');
  const out = setIni('PVP=true\r\nPauseEmpty=true\r\nPublicName=Старое\r\n', { PublicName: 'Новое', MaxPlayers: 8, PVP: 'false' });
  assert.strictEqual(out, 'PVP=false\r\nPauseEmpty=true\r\nPublicName=Новое\r\nMaxPlayers=8\r\n');
  assert.strictEqual(setIni('', { A: 1 }), 'A=1\r\n');
});

test('Project Zomboid: запуск пишет настройки и передаёт папку данных', () => {
  const pz = getGame('zomboid');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
  assert.throws(() => pz.launch({ dir, s: cleanSettings(pz, {}) }), /StartServer64/);
  fs.writeFileSync(path.join(dir, 'game', 'StartServer64.bat'), PZ_BAT);
  const s = cleanSettings(pz, { name: 'Зомби', password: 'pw', players: 4, workshop: '2169435993;2392709985', mods: 'modA;modB', memory: '8', adminPassword: 'adm' });
  const spec = pz.launch({ dir, s });
  assert.strictEqual(spec.cmd, path.join(dir, 'game', 'jre64', 'bin', 'java.exe'));
  assert.ok(spec.args.includes(`-cachedir=${path.join(dir, 'zomboid')}`));
  assert.strictEqual(spec.args[spec.args.indexOf('-adminpassword') + 1], 'adm');
  assert.strictEqual(spec.args[spec.args.indexOf('-udpport') + 1], 16262);
  assert.ok(spec.args.includes('-Xmx8g'));
  const ini = fs.readFileSync(path.join(dir, 'zomboid', 'Server', 'server.ini'), 'utf8');
  for (const line of ['PublicName=Зомби', 'Password=pw', 'MaxPlayers=4', 'WorkshopItems=2169435993;2392709985', 'Mods=modA;modB', 'DefaultPort=16261', 'UDPPort=16262']) assert.ok(ini.includes(line + '\r\n'), line);
  assert.throws(() => cleanSettings(pz, { workshop: 'abc' }), /недопустимые/);
  assert.match('[16-11-26 12:00:00.000] LOG  : Network , 1> ConnectionManager: [fully-connected] "" connection: guid=1 ip=1.2.3.4 steam-id=7656 access= username="Вася" connection-type="UDPRakNet"', pz.joinRe);
  assert.deepStrictEqual(portsOf(pz, s), [16261, 16262]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('7 Days to Die: serverconfig.xml собирается из образца игры', () => {
  const g = getGame('sdtd');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'game', 'serverconfig.xml'),
    '<?xml version="1.0"?>\n<ServerSettings>\n\t<property name="ServerName" value="My Game Host"/>\n\t<property name="Region" value="NorthAmericaEast"/>\n\t<!-- <property name="UserDataFolder" value="absolute path" /> -->\n\t<property name="TelnetPort" value="8081"/>\n</ServerSettings>\n'
  );
  const s = cleanSettings(g, { name: 'Орда & друзья', world: 'RWG', seed: 'abc', port: 26900 });
  const spec = g.launch({ dir, s });
  const xml = fs.readFileSync(path.join(dir, 'serverconfig.xml'), 'utf8');
  assert.match(xml, /<property name="ServerName" value="Орда &amp; друзья"\/>/);
  assert.match(xml, /<property name="Region" value="NorthAmericaEast"\/>/); // чужие ключи сохранились
  assert.match(xml, /<!-- <property name="UserDataFolder" value="absolute path" \/> -->/); // комментарий не тронут
  assert.ok(xml.includes(`<property name="UserDataFolder" value="${path.join(dir, 'saves')}"/>`));
  assert.match(xml, /<property name="TelnetPort" value="26904"\/>/);
  assert.match(xml, /<property name="TerminalWindowEnabled" value="false"\/>/);
  assert.match(xml, /<property name="GameWorld" value="RWG"\/>/);
  assert.ok(!/SandboxCode/.test(xml)); // пустой код не пишем
  assert.strictEqual(xml.match(/name="ServerName"/g).length, 1);
  assert.strictEqual(spec.readyPort, 26904);
  assert.strictEqual(spec.args[spec.args.length - 1], '-dedicated');
  assert.ok(spec.args.includes(`-configfile=${path.join(dir, 'serverconfig.xml')}`));
  // Повторный запуск берёт уже свой файл и ничего не дублирует.
  g.launch({ dir, s: cleanSettings(g, { sandbox: 'ABC123' }) });
  const again = fs.readFileSync(path.join(dir, 'serverconfig.xml'), 'utf8');
  assert.strictEqual(again.match(/name="TelnetPort"/g).length, 1);
  assert.match(again, /<property name="SandboxCode" value="ABC123"\/>/);
  assert.match('2026-11-16T14:20:00 123.456 INF PlayerSpawnedInWorld (reason: EnterMultiplayer, position: 1, 2, 3): EntityID=171, PltfmId=\'Steam_1\', CrossId=\'EOS_1\', OwnerID=\'Steam_1\', PlayerName=\'Вася\', ClientNumber=\'1\'', g.joinRe);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('7 Days to Die: второй сервер не залезает на порты первого, включая telnet', () => {
  const g = getGame('sdtd');
  const a = cleanSettings(g, {});
  assert.deepStrictEqual(portsOf(g, a), [26900, 26901, 26902, 26903, 26904]);
  const b = freePorts(g, cleanSettings(g, {}), portsOf(g, a));
  assert.ok(portsOf(g, b).every((p) => !portsOf(g, a).includes(p)));
});

test('telnet: вход, команда, ответ без строк журнала', async () => {
  const srv = net.createServer((sock) => {
    sock.write('*** Connected with 7DTD server.\r\n*** Server version: V 3.0\r\n\r\n');
    sock.on('data', (d) => {
      const cmd = String(d).trim();
      if (cmd === 'listplayers') {
        sock.write('2026-11-16T14:20:00 1.0 INF Executing command \'listplayers\' by Telnet from 127.0.0.1\r\n');
        sock.write('0. id=171, Вася, pos=(1.0, 2.0, 3.0)\r\nTotal of 1 in the game\r\n');
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const link = await telnet({ port: srv.address().port, replyMs: 200 });
  assert.strictEqual(await link.send('listplayers'), '0. id=171, Вася, pos=(1.0, 2.0, 3.0)\nTotal of 1 in the game');
  link.close();
  srv.close();
  assert.strictEqual(telnetReply('\xff\xfb\x01ok\r\n2026-01-01T00:00:00 1 INF x\r\n'), 'ok');
});

test('telnet: пароль отправляется, если сервер его просит', async () => {
  const srv = net.createServer((sock) => {
    sock.write('Please enter password:\r\n');
    sock.once('data', (d) => sock.write(String(d).trim() === 'секрет' ? 'Logon successful.\r\n' : 'Password incorrect, please enter password:\r\n'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  (await telnet({ port, password: 'секрет' })).close();
  await assert.rejects(telnet({ port, password: 'нет' }), /не принял пароль/);
  await assert.rejects(telnet({ port }), /просит пароль/);
  srv.close();
});

test('сервер считается запущенным, когда открыл порт управления', async () => {
  const events = [];
  const runner = createRunner((type, p) => events.push({ type, ...p }));
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();
  runner.start('t', { cmd: process.execPath, args: [path.join(__dirname, 'fake-server.js')], cwd: __dirname, console: 'stdin', stopCmd: 'exit', readyPort: port, readyProbeMs: 50 });
  await sleep(300);
  assert.strictEqual(runner.state('t'), 'starting'); // «Server started» в журнале не в счёт: readyRe не задан
  const srv = net.createServer();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const end = Date.now() + 3000;
  while (runner.state('t') !== 'running' && Date.now() < end) await sleep(25);
  assert.strictEqual(runner.state('t'), 'running');
  runner.stop('t');
  while (runner.has('t')) await sleep(25);
  srv.close();
});

test('Enshrouded: настройки и группы паролей', () => {
  const g = getGame('enshrouded');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'game', 'enshrouded_server.json'),
    '﻿' + JSON.stringify({ name: 'x', gamePort: 15636, password: 'old', gameSettings: { playerHealthFactor: 2 }, userGroups: [{ name: 'Admin', password: 'a' }, { name: 'Guest', password: 'g' }] })
  );
  const s = cleanSettings(g, { name: 'Туман', password: 'друзья', players: 6, preset: 'Hard', adminPassword: 'админ' });
  const spec = g.launch({ dir, s });
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'game', 'enshrouded_server.json'), 'utf8'));
  assert.strictEqual(c.name, 'Туман');
  assert.strictEqual(c.queryPort, 15637);
  assert.strictEqual(c.slotCount, 6);
  assert.strictEqual(c.gameSettingsPreset, 'Hard');
  assert.strictEqual(c.gamePort, undefined);
  assert.strictEqual(c.password, undefined);
  assert.deepStrictEqual(c.gameSettings, { playerHealthFactor: 2 }); // свои тонкие настройки пользователя сохраняются
  assert.deepStrictEqual(c.userGroups.map((u) => [u.name, u.password]), [['Admin', 'админ'], ['Friend', 'друзья'], ['Guest', 'g']]);
  assert.ok(spec.ctrlC && !spec.logFile); // журнал идёт в консоль; файл не читаем, чтобы строки не задвоились
  assert.throws(() => cleanSettings(g, { password: 'same', adminPassword: 'same' }), /не должен совпадать/);
  assert.throws(() => cleanSettings(g, { players: 17 }), /от 1 до 16/);
  fs.rmSync(dir, { recursive: true, force: true });
});
