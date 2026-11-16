const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createRunner, tailFile } = require('../lib/runner');
const { encodePacket, decodePackets, sourceRcon, palRequest } = require('../lib/rcon');
const backup = require('../lib/backup');
const { sleep } = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-test-'));
const FAKE = path.join(__dirname, 'fake-server.js');

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error('не дождались условия');
}

function harness() {
  const events = [];
  const runner = createRunner((type, p) => events.push({ type, ...p }));
  const spec = (extra = {}, args = []) => ({
    cmd: process.execPath,
    args: [FAKE, ...args],
    cwd: __dirname,
    console: 'stdin',
    stopCmd: 'exit',
    readyRe: /Server started/,
    joinRe: /^(.{1,40}) has joined\.$/,
    leaveRe: /^(.{1,40}) has left\.$/,
    ...extra,
  });
  return { events, runner, spec };
}

test('сервер запускается, принимает команды, видит игроков и мягко останавливается', async () => {
  const { events, runner, spec } = harness();
  runner.start('a', spec());
  assert.throws(() => runner.start('a', spec()), /уже запущен/);
  await until(() => runner.state('a') === 'running');
  await runner.command('a', 'join Вася');
  await runner.command('a', 'привет\nмир');
  await until(() => runner.players('a').length === 1);
  assert.deepStrictEqual(runner.players('a'), ['Вася']);
  await until(() => runner.lines('a').some((l) => l.text === 'echo: привет мир'));
  assert.ok(runner.lines('a').some((l) => l.kind === 'input' && l.text === '> join Вася'));
  await runner.command('a', 'leave Вася');
  await until(() => runner.players('a').length === 0);
  runner.stop('a');
  await until(() => !runner.has('a'));
  const exit = events.find((e) => e.type === 'exit');
  assert.strictEqual(exit.expected, true);
  assert.ok(exit.lines.some((l) => l.text === 'Saving world...'));
  assert.deepStrictEqual(events.filter((e) => e.type === 'state').map((e) => e.state), ['starting', 'running', 'stopping', 'stopped']);
  assert.deepStrictEqual(events.filter((e) => e.type === 'player').map((e) => e.joined), [true, false]);
});

test('падение сервера отличается от остановки', async () => {
  const { events, runner, spec } = harness();
  runner.start('b', spec({}, ['--crash']));
  await until(() => events.some((e) => e.type === 'exit'));
  const exit = events.find((e) => e.type === 'exit');
  assert.strictEqual(exit.expected, false);
  assert.strictEqual(exit.code, 3);
  await assert.rejects(runner.command('b', 'x'), /не запущен/);
});

test('сервер без команды остановки и без ответа завершается принудительно', async () => {
  const { runner, spec } = harness();
  runner.start('c', spec({ stopCmd: 'не-знаю-такой', stopGraceMs: 300 }));
  await until(() => runner.state('c') === 'running');
  runner.stop('c');
  await until(() => !runner.has('c'));
});

test('остановка через Ctrl+C доходит до сервера (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { events, runner, spec } = harness();
  const dir = tmp();
  runner.start('d', spec({ ctrlC: true, cwd: dir, console: 'none', stopGraceMs: 20000 }, ['имя с пробелом']));
  await until(() => runner.state('d') === 'running', 20000);
  assert.ok(runner.lines('d').some((l) => l.text.includes('имя с пробелом')), 'аргументы дошли через обёртку');
  await assert.rejects(runner.command('d', 'x'), /нет консоли/);
  runner.stop('d');
  await until(() => !runner.has('d'), 25000);
  assert.ok(runner.ctrlCRecently());
  const exit = events.find((e) => e.type === 'exit');
  assert.ok(exit.lines.some((l) => l.text === 'Saving on Ctrl+C'), 'сервер получил сигнал и успел сохраниться');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('журнал из файла читается по мере записи', async () => {
  const dir = tmp();
  const file = path.join(dir, 'log.txt');
  const got = [];
  const t = tailFile(file, (l) => got.push(l), 30);
  fs.writeFileSync(file, 'раз\r\nдва\nтр');
  await until(() => got.length === 2);
  fs.appendFileSync(file, 'и\n');
  await until(() => got.length === 3);
  t.stop();
  assert.deepStrictEqual(got, ['раз', 'два', 'три']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RCON: пакеты собираются и разбираются, в том числе по кускам', () => {
  const a = encodePacket(7, 2, 'status');
  const b = encodePacket(8, 0, 'привет');
  const all = Buffer.concat([a, b]);
  const part = decodePackets(all.subarray(0, a.length + 5));
  assert.deepStrictEqual(part.packets, [{ id: 7, type: 2, body: 'status' }]);
  const rest = decodePackets(Buffer.concat([part.rest, all.subarray(a.length + 5)]));
  assert.deepStrictEqual(rest.packets, [{ id: 8, type: 0, body: 'привет' }]);
  assert.strictEqual(rest.rest.length, 0);
});

test('RCON: вход по паролю и команда на поддельном сервере', async () => {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      const r = decodePackets(Buffer.concat([buf, d]));
      buf = r.rest;
      for (const p of r.packets) {
        if (p.type === 3) {
          sock.write(encodePacket(p.id, 0, ''));
          sock.write(encodePacket(p.body === 'верный' ? p.id : -1, 2, ''));
        } else sock.write(encodePacket(p.id, 0, 'ответ на ' + p.body));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const link = await sourceRcon({ port, password: 'верный' });
  assert.strictEqual(await link.send('status'), 'ответ на status');
  link.close();
  await assert.rejects(sourceRcon({ port, password: 'нет' }), /не принял пароль/);
  srv.close();
});

test('Palworld: команды консоли превращаются в запросы REST', () => {
  assert.deepStrictEqual(palRequest('save'), { method: 'POST', path: 'save' });
  assert.deepStrictEqual(palRequest('announce Всем привет').body, { message: 'Всем привет' });
  assert.strictEqual(palRequest('shutdown 30').body.waittime, 30);
  assert.strictEqual(palRequest('announce'), null);
  assert.strictEqual(palRequest('чтоугодно'), null);
});

test('копии: создание, список, восстановление, чистка', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'worlds', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worlds', 'мир.wld'), 'первый');
  fs.writeFileSync(path.join(dir, 'worlds', 'sub', 'a.txt'), 'a');
  await assert.rejects(backup.create(dir, ['нет-такой'], 'manual'), /нечего/);
  const n1 = await backup.create(dir, ['worlds', 'нет-такой'], 'manual', new Date(2026, 0, 1, 10, 0, 0));
  assert.match(n1, /^2026-01-01_10-00-00_manual\./);
  fs.writeFileSync(path.join(dir, 'worlds', 'мир.wld'), 'второй');
  fs.writeFileSync(path.join(dir, 'worlds', 'лишний.txt'), 'x');
  await backup.restore(dir, n1, ['worlds']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'worlds', 'мир.wld'), 'utf8'), 'первый');
  assert.ok(!fs.existsSync(path.join(dir, 'worlds', 'лишний.txt')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'worlds', 'sub', 'a.txt'), 'utf8'), 'a');

  for (let h = 1; h <= 4; h++) await backup.create(dir, ['worlds'], 'schedule', new Date(2026, 0, 2, h, 0, 0));
  backup.prune(dir, 2);
  const list = backup.list(dir);
  assert.deepStrictEqual(list.map((b) => b.reason), ['по расписанию', 'по расписанию', 'вручную']);
  assert.ok(list[0].time > list[1].time && list[0].size > 0);
  assert.throws(() => backup.remove(dir, '..\\..\\x.zip'), /Некорректное/);
  await assert.rejects(backup.restore(dir, '../x.zip', ['worlds']), /Некорректное/);
  backup.remove(dir, n1);
  assert.strictEqual(backup.list(dir).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('строки хода заменяют друг друга, приглашение консоли срезается', async () => {
  const { events, runner, spec } = harness();
  runner.start('p', spec({ stripRe: /^(?:: )+/ }));
  await until(() => runner.state('p') === 'running');
  for (const c of ['Gen 1%', 'Gen 2%', 'Other 5%', 'Gen 3%', 'Other 6%', 'done']) await runner.command('p', c, { echo: false });
  await runner.command('p', 'join : Вася', { echo: false });
  await until(() => runner.lines('p').some((l) => l.text === 'echo: done'));
  const texts = runner.lines('p').map((l) => l.text).filter((x) => /Gen|Other|done/.test(x));
  assert.deepStrictEqual(texts, ['echo: Gen 3%', 'echo: Other 6%', 'echo: done']);
  assert.deepStrictEqual(events.filter((e) => e.type === 'log' && /Gen/.test(e.text)).map((e) => e.replace), [0, 1, 2]);
  runner.stop('p');
  await until(() => !runner.has('p'));
});
