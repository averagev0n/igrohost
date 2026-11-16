// Запущенные серверы: процесс, журнал последних строк, состояние, команды и остановка.
//
// Игры ведут себя по-разному, поэтому запуск описывается набором свойств (spec):
//   cmd, args, cwd, env  — что запускать;
//   logFile              — если сервер пишет журнал в файл, а не в консоль (Unity, CS2);
//   console: 'stdin' | 'link' | 'none' — куда отправлять команды;
//   link                 — описание канала RCON/REST для console: 'link';
//   stopCmd              — команда мягкой остановки; ctrlC — остановка сигналом Ctrl+C;
//   readyRe, readyAfterMs, readyPort (готов, когда открыт этот порт), joinRe, leaveRe.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { killTree } = require('./util');
const { openLink } = require('./rcon');

const MAX_LINES = 2000;
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
// В собранной программе скрипты лежат рядом с архивом app.asar: PowerShell не умеет читать из него.
const PS_DIR = path.join(__dirname, 'ps').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const WRAP_PS1 = path.join(PS_DIR, 'wrap.ps1');
const CTRLC_PS1 = path.join(PS_DIR, 'ctrlc.ps1');
const CONIN_PS1 = path.join(PS_DIR, 'coninput.ps1');
const WIN = process.platform === 'win32';

/** Читает дописываемый файл журнала и отдаёт новые строки. */
function tailFile(file, onLine, every = 700) {
  let pos = 0;
  let buf = '';
  let busy = false;
  const tick = () => {
    if (busy) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < pos) pos = 0;
    if (size === pos) return;
    busy = true;
    const stream = fs.createReadStream(file, { start: pos, end: size - 1, encoding: 'utf8' });
    stream.on('data', (d) => {
      buf += d;
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const l of parts) onLine(l.replace(/\r$/, ''));
    });
    const done = () => {
      pos = size;
      busy = false;
    };
    stream.on('end', done);
    stream.on('error', done);
  };
  const timer = setInterval(tick, every);
  return {
    stop() {
      clearInterval(timer);
      tick();
    },
  };
}

function createRunner(onEvent, deps = {}) {
  const procs = new Map(); // id → запись
  let ctrlCUntil = 0;

  const setState = (e, state) => {
    e.state = state;
    onEvent('state', { id: e.id, state });
  };

  function start(id, spec) {
    if (procs.has(id)) throw new Error('Сервер уже запущен');
    const e = { id, spec, state: 'starting', lines: [], players: new Set(), link: null, startedAt: Date.now(), timers: [] };

    const push = (text, kind = 'server') => {
      text = String(text).replace(ANSI_RE, '');
      if (spec.stripRe) text = text.replace(spec.stripRe, '');
      if (!text.trim()) return;
      // Строки хода («Создание мира — 45%») не копим тысячами: новая заменяет прежнюю такую же.
      const key = /\d%/.test(text) ? kind + text.replace(/[\d.]+/g, '#') : null;
      let replace = 0;
      if (key) {
        const n = e.lines.length;
        if (n >= 1 && e.lines[n - 1].key === key) replace = 1;
        else if (n >= 2 && e.lines[n - 2].key === key) replace = 2;
      }
      if (replace) e.lines[e.lines.length - replace] = { text, kind, key };
      else e.lines.push({ text, kind, key });
      if (e.lines.length > MAX_LINES) e.lines.splice(0, e.lines.length - MAX_LINES);
      onEvent('log', { id, text, kind, replace });
      if (kind !== 'server' && kind !== 'error') return;
      if (e.state === 'starting' && spec.readyRe && spec.readyRe.test(text)) setState(e, 'running');
      const j = spec.joinRe && spec.joinRe.exec(text);
      if (j) {
        const name = j[j.length - 1].trim();
        if (!e.players.has(name)) {
          e.players.add(name);
          onEvent('player', { id, name, joined: true, online: e.players.size });
        }
        return;
      }
      const l = spec.leaveRe && spec.leaveRe.exec(text);
      if (l) {
        const name = l[l.length - 1].trim();
        if (e.players.delete(name)) onEvent('player', { id, name, joined: false, online: e.players.size });
      }
    };
    e.push = push;

    if (spec.logFile) {
      fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
      fs.rmSync(spec.logFile, { force: true });
    }

    let cmd = spec.cmd;
    let args = spec.args.map(String);
    if (spec.ctrlC && process.platform === 'win32') {
      // Обёртка снимает унаследованный запрет на Ctrl+C, иначе сервер не получит сигнал остановки.
      const argFile = path.join(spec.cwd, '.igrohost-args.txt');
      fs.writeFileSync(argFile, args.join('\r\n'), 'utf8');
      args = [...PS_ARGS, WRAP_PS1, cmd, argFile];
      cmd = 'powershell.exe';
    }
    const opts = { cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) }, windowsHide: true };
    if ((spec.utf8Console || spec.conInput) && WIN) {
      // Консольные серверы на .NET читают и пишут в кодировке консоли Windows (для русской — 866).
      // Переключаем её на UTF-8, иначе русские имена и сообщения превращаются в мусор.
      if ([cmd, ...args].some((a) => /["%\r\n]/.test(a))) throw new Error('В пути к серверу есть недопустимые символы (% или кавычки)');
      // conInput: ввод сервера — скрытая консоль (<CON); команды в неё «набирает» coninput.ps1.
      const line = 'chcp 65001>nul & ' + [cmd, ...args].map((a) => `"${a}"`).join(' ') + (spec.conInput ? ' <CON' : '');
      args = ['/d', '/s', '/c', `"${line}"`];
      cmd = process.env.ComSpec || 'cmd.exe';
      opts.windowsVerbatimArguments = true;
    }
    const proc = spawn(cmd, args, opts);
    e.proc = proc;
    procs.set(id, e);

    const pipe = (stream, kind) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const raw of parts) push(raw.replace(/\r$/, ''), kind);
      });
    };
    pipe(proc.stdout, 'server');
    pipe(proc.stderr, 'error');
    proc.stdin.on('error', () => {});
    if (spec.logFile) e.tail = tailFile(spec.logFile, (l) => push(l, 'server'));

    proc.on('error', (err) => push(`Не удалось запустить сервер: ${err.message}`, 'error'));
    proc.on('close', (code) => {
      e.timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
      if (e.tail) e.tail.stop();
      if (e.link) e.link.close();
      if (e.helper) e.helper.kill();
      const expected = e.state === 'stopping';
      push(`Сервер остановлен${code ? ` (код ${code})` : ''}.`, expected || !code ? 'info' : 'error');
      procs.delete(id);
      onEvent('state', { id, state: 'stopped' });
      onEvent('exit', { id, code, expected, uptime: Date.now() - e.startedAt, lines: e.lines });
    });

    if (spec.readyAfterMs) {
      e.timers.push(
        setTimeout(() => {
          if (e.state === 'starting') setState(e, 'running');
        }, spec.readyAfterMs)
      );
    }
    if (spec.readyPort) {
      // Сервер готов, когда открыл порт управления (так делает 7 Days to Die: telnet поднимается последним).
      const probe = setInterval(() => {
        if (e.state !== 'starting') return clearInterval(probe);
        const sock = net.connect({ host: '127.0.0.1', port: spec.readyPort });
        sock.setTimeout(2000);
        sock.on('connect', () => {
          sock.destroy();
          clearInterval(probe);
          if (e.state === 'starting') setState(e, 'running');
        });
        sock.on('error', () => sock.destroy());
        sock.on('timeout', () => sock.destroy());
      }, spec.readyProbeMs || 3000);
      e.timers.push(probe);
    }
    setState(e, 'starting');
  }

  /** Набрать строку в скрытой консоли сервера (см. coninput.ps1). */
  function conSend(e, text) {
    if (!e.helper) {
      const helper = spawn('powershell.exe', [...PS_ARGS, CONIN_PS1, String(e.proc.pid)], { windowsHide: true });
      e.helper = helper;
      helper.stdin.on('error', () => {});
      helper.on('error', () => {});
      helper.on('close', (code) => {
        if (e.helper === helper) e.helper = null;
        if (!code || !procs.has(e.id)) return;
        e.push('Не удалось передать команду серверу.', 'error');
        if (e.state === 'stopping') killTree(e.proc.pid);
      });
    }
    e.helper.stdin.write(text + '\n', 'utf8');
  }

  async function getLink(e) {
    if (e.link) return e.link;
    const link = await openLink(e.spec.link, deps);
    e.link = link;
    return link;
  }

  /** Отправить команду на сервер; ответ (если есть) попадает в журнал. */
  async function command(id, text, { echo = true } = {}) {
    const e = procs.get(id);
    if (!e) throw new Error('Сервер не запущен');
    text = String(text).replace(/[\r\n]/g, ' ').trim();
    if (!text) return '';
    if (e.spec.console === 'none') throw new Error('У этого сервера нет консоли команд');
    if (echo) e.push('> ' + text, 'input');
    if (e.spec.console === 'stdin') {
      if (e.spec.conInput && WIN) conSend(e, text);
      else e.proc.stdin.write(text + '\n');
      return '';
    }
    let reply;
    try {
      reply = await (await getLink(e)).send(text);
    } catch (err) {
      e.link = null;
      throw new Error(e.state === 'starting' ? 'Сервер ещё запускается — консоль заработает чуть позже' : err.message);
    }
    if (reply) for (const l of String(reply).split('\n')) e.push(l, 'reply');
    return reply || '';
  }

  function sendCtrlC(e) {
    if (process.platform !== 'win32') {
      e.proc.kill('SIGINT');
      return;
    }
    ctrlCUntil = Date.now() + 5000;
    spawn('powershell.exe', [...PS_ARGS, CTRLC_PS1, String(e.proc.pid)], { windowsHide: true }).on('error', () => killTree(e.proc.pid));
  }

  /** Мягко остановить; если сервер не выйдет за отведённое время — завершить принудительно. */
  function stop(id) {
    const e = procs.get(id);
    if (!e || e.state === 'stopping') return;
    setState(e, 'stopping');
    const spec = e.spec;
    const grace = spec.stopGraceMs || 60000;
    e.timers.push(
      setTimeout(() => {
        e.push('Сервер не остановился сам — завершаю принудительно.', 'error');
        killTree(e.proc.pid);
      }, grace)
    );
    if (spec.ctrlC) return sendCtrlC(e);
    if (!spec.stopCmd) return killTree(e.proc.pid);
    command(id, spec.stopCmd, { echo: false }).catch(() => {
      // Канал управления недоступен (сервер не успел запуститься) — остаётся только завершить процесс.
      killTree(e.proc.pid);
    });
  }

  function stopAll() {
    return Promise.all(
      [...procs.values()].map(
        (e) =>
          new Promise((resolve) => {
            e.proc.once('close', resolve);
            stop(e.id);
          })
      )
    );
  }

  return {
    start,
    stop,
    stopAll,
    command,
    has: (id) => procs.has(id),
    state: (id) => (procs.get(id) || { state: 'stopped' }).state,
    lines: (id) => (procs.get(id) || { lines: [] }).lines.slice(),
    players: (id) => [...(procs.get(id) || { players: [] }).players],
    startedAt: (id) => (procs.get(id) || {}).startedAt || 0,
    pid: (id) => (procs.has(id) ? procs.get(id).proc.pid : null),
    /** Дождаться, пока сервер завершится (сразу, если он не запущен). */
    exited: (id) => (procs.has(id) ? new Promise((r) => procs.get(id).proc.once('close', () => setTimeout(r, 50))) : Promise.resolve()),
    /** Панель сама послала Ctrl+C серверу — свой обработчик сигнала должен это пропустить. */
    ctrlCRecently: () => Date.now() < ctrlCUntil,
  };
}

module.exports = { createRunner, tailFile };
