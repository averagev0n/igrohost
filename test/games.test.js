const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GAMES, getGame, defaults, cleanSettings, portsOf, freePorts, publicGame } = require('../lib/games');
const { parseProgress, explainError } = require('../lib/steamcmd');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));

test('у каждой игры есть всё, что нужно панели', () => {
  assert.deepStrictEqual(GAMES.map((g) => g.id), ['terraria', 'valheim', 'rust', 'cs2', 'palworld', 'zomboid', 'sdtd', 'enshrouded']);
  for (const g of GAMES) {
    const s = cleanSettings(g, {});
    assert.ok(g.fields.filter((f) => f.port).length === 1, g.id + ': одно поле порта');
    assert.ok(g.ports(s).length >= 1);
    assert.ok(g.saves({ settings: s }).length >= 1);
    assert.ok(path.isAbsolute(g.exe('C:\\x')));
    assert.ok(['stdin', 'link', 'none'].includes(g.console));
    // Без пароля можно только telnet: тогда 7 Days to Die слушает его лишь на этом компьютере.
    if (g.console === 'link') assert.ok(g.link(s).port > 0 && (g.link(s).password || g.link(s).type === 'telnet'));
    JSON.stringify(publicGame(g)); // описание для интерфейса сериализуется
  }
});

test('настройки по умолчанию проходят проверку, пароли создаются сами', () => {
  const v = defaults(getGame('valheim'));
  assert.ok(v.password.length >= 5);
  const r = cleanSettings(getGame('rust'), { rconPassword: '' });
  assert.ok(r.rconPassword.length >= 8);
});

test('проверка настроек: типы, границы, списки, кавычки', () => {
  const t = getGame('terraria');
  assert.throws(() => cleanSettings(t, { port: 80 }), /от 1024/);
  assert.throws(() => cleanSettings(t, { maxplayers: 'много' }), /нужно число/);
  assert.throws(() => cleanSettings(t, { size: '9' }), /из списка/);
  assert.throws(() => cleanSettings(t, { worldname: '' }), /Заполните/);
  assert.strictEqual(cleanSettings(t, { motd: 'при"вет\n' }).motd, 'при вет');
  assert.throws(() => cleanSettings(getGame('cs2'), { map: 'de_dust2; quit' }), /недопустимые/);
  assert.strictEqual(cleanSettings(getGame('palworld'), { expRate: '2.5' }).expRate, 2.5);
});

test('Valheim: пароль не короче 5 символов и не часть названия', () => {
  const v = getGame('valheim');
  assert.throws(() => cleanSettings(v, { password: '123' }), /не короче 5/);
  assert.throws(() => cleanSettings(v, { name: 'Викинги secret', password: 'secret' }), /входит в название/);
});

test('порты: второй сервер той же игры получает свободные', () => {
  const v = getGame('valheim');
  const a = cleanSettings(v, {});
  assert.deepStrictEqual(portsOf(v, a), [2456, 2457]);
  const b = freePorts(v, cleanSettings(v, {}), portsOf(v, a));
  assert.strictEqual(b.port, 2466);
  const r = getGame('rust');
  assert.deepStrictEqual(portsOf(r, cleanSettings(r, {})).sort(), [28015, 28016, 28017]);
});

test('Terraria: файл настроек и запуск', () => {
  const t = getGame('terraria');
  const dir = tmp();
  const s = cleanSettings(t, { worldname: 'Мой: мир', password: 'pw', seed: 'abc' });
  const spec = t.launch({ dir, s });
  const cfg = fs.readFileSync(path.join(dir, 'serverconfig.txt'), 'utf8');
  assert.match(cfg, /worldname=Мой мир\r\n/);
  assert.ok(cfg.includes(`world=${path.join(dir, 'worlds', 'Мой мир.wld')}`));
  assert.match(cfg, /port=7777\r\n/);
  assert.match(cfg, /seed=abc/);
  assert.ok(spec.cmd.endsWith(path.join('game', 'TerrariaServer.exe')));
  // С установленным TShock запускается он.
  fs.mkdirSync(path.join(dir, 'tshock'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tshock', 'TShock.Server.exe'), '');
  assert.ok(t.launch({ dir, s }).cmd.endsWith('TShock.Server.exe'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Valheim и Rust: аргументы запуска', () => {
  const v = getGame('valheim');
  const sv = cleanSettings(v, { name: 'Север', password: 'tainaya', crossplay: true, preset: 'hard' });
  const a = v.launch({ dir: 'C:\\srv', s: sv });
  assert.strictEqual(a.args[a.args.indexOf('-name') + 1], 'Север');
  assert.ok(a.args.includes('-crossplay') && a.args.includes('hard'));
  assert.strictEqual(a.env.SteamAppId, '892970');
  assert.ok(a.ctrlC && a.logFile);

  const r = getGame('rust');
  const sr = cleanSettings(r, { hostname: 'Мой Rust', rconPassword: 'pw123456' });
  const b = r.launch({ dir: 'C:\\srv', s: sr });
  assert.strictEqual(b.args[b.args.indexOf('+rcon.port') + 1], 28016);
  assert.strictEqual(b.args[b.args.indexOf('+rcon.ip') + 1], '127.0.0.1');
  assert.ok(!b.args.includes('+server.description'));
  assert.deepStrictEqual(r.link(sr), { type: 'webrcon', port: 28016, password: 'pw123456' });
  assert.match('1.2.3.4:5555/76561198000000001/Вася joined [windows/76561198000000001]', r.joinRe);
});

test('CS2: строка Metamod в gameinfo.gi добавляется один раз', () => {
  const { patchGameInfo } = getGame('cs2');
  const src = ['\tFileSystem', '\t{', '\t\tSearchPaths', '\t\t{', '\t\t\tGame_LowViolence\tcsgo_lv // Perfect World content override', '\t\t\tGame\tcsgo', '\t\t}', '\t}'].join('\r\n');
  const out = patchGameInfo(src);
  const lines = out.split('\r\n');
  assert.strictEqual(lines[5], '\t\t\tGame\tcsgo/addons/metamod');
  assert.strictEqual(lines[6], '\t\t\tGame\tcsgo');
  assert.strictEqual(patchGameInfo(out), null);
  assert.strictEqual(patchGameInfo('что-то другое'), null);
});

test('CS2: режим и необязательные параметры', () => {
  const c = getGame('cs2');
  const s = cleanSettings(c, { mode: 'wingman', password: 'pw', gslt: '' });
  const a = c.launch({ dir: tmp(), s }).args;
  assert.strictEqual(a[a.indexOf('+game_mode') + 1], 2);
  assert.ok(a.includes('+sv_password') && !a.includes('+sv_setsteamaccount'));
});

test('Palworld: настройки вписываются в строку OptionSettings', () => {
  const p = getGame('palworld');
  const base = '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ExpRate=1.000000,ServerName="Default, Server",CrossplayPlatforms=(Steam,Xbox),RESTAPIEnabled=False,AdminPassword="")';
  const map = p.parseOptions(base.split('\n')[1]);
  assert.strictEqual(map.get('ServerName'), '"Default, Server"');
  assert.strictEqual(map.get('CrossplayPlatforms'), '(Steam,Xbox)');
  const s = cleanSettings(p, { name: 'Палы', expRate: 3, adminPassword: 'adm', port: 8211 });
  const ini = p.buildIni(base, s);
  const out = p.parseOptions(ini.split('\r\n')[1]);
  assert.strictEqual(out.get('ServerName'), '"Палы"');
  assert.strictEqual(out.get('ExpRate'), '3.000000');
  assert.strictEqual(out.get('RESTAPIEnabled'), 'True');
  assert.strictEqual(out.get('RESTAPIPort'), '8212');
  assert.strictEqual(out.get('Difficulty'), 'None'); // чужие ключи сохраняются
  assert.strictEqual(out.get('CrossplayPlatforms'), '(Steam,Xbox)');
  // Без исходного файла тоже получается рабочая строка.
  assert.match(p.buildIni('', s), /OptionSettings=\(ServerName="Палы"/);
});

test('Palworld: запуск пишет ini и берёт основу из файла по умолчанию', () => {
  const p = getGame('palworld');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'game'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game', 'DefaultPalWorldSettings.ini'), '; comment\n[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(A=1,B=2,C=3,D=4,E=5,PalEggDefaultHatchingTime=72.000000)\n');
  const s = cleanSettings(p, { public: true });
  const spec = p.launch({ dir, s });
  const ini = fs.readFileSync(path.join(dir, 'game', 'Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini'), 'utf8');
  assert.match(ini, /PalEggDefaultHatchingTime=72\.000000/);
  assert.match(ini, /ServerPlayerMaxNum=16/);
  assert.ok(spec.args.includes('-publiclobby') && spec.args.includes('-port=8211'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SteamCMD: прогресс и объяснение ошибок', () => {
  assert.deepStrictEqual(parseProgress(' Update state (0x61) downloading, progress: 12.34 (123 / 456)'), { stage: 'Скачивание', pct: 12.34, done: 123, total: 456 });
  assert.strictEqual(parseProgress(' Update state (0x5) verifying install, progress: 99.9 (1 / 2)').stage, 'Проверка файлов');
  assert.strictEqual(parseProgress('Loading Steam API...OK'), null);
  assert.match(explainError("ERROR! Failed to install app '730' (Not enough disk space)"), /места/);
  assert.match(explainError("ERROR! Failed to install app '1' (No subscription)"), /без входа/);
});

test('SteamCMD: при первом запуске «Missing configuration» — повод повторить, нехватка места — нет', () => {
  const { isTransient } = require('../lib/steamcmd');
  assert.ok(isTransient("ERROR! Failed to install app '2278520' (Missing configuration)"));
  assert.ok(isTransient("ERROR! Failed to install app '730' (No connection)"));
  assert.ok(!isTransient("ERROR! Failed to install app '730' (Not enough disk space)"));
  assert.ok(!isTransient("ERROR! Failed to install app '1' (No subscription)"));
});
