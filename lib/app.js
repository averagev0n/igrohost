// Ядро панели: связывает хранилище, установку, запуск, копии, моды и Telegram.
// Наружу — одна функция call(метод, аргумент) и поток событий emit(канал, данные).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createStore } = require('./store');
const { createRunner } = require('./runner');
const { GAMES, getGame, defaults, cleanSettings, portsOf, freePorts, publicGame } = require('./games');
const { ensureSteamCmd, appUpdate } = require('./steamcmd');
const { download, unzip, getJson } = require('./fetchfile');
const { cleanText, moveInto, sleep, dirSize } = require('./util');
const backup = require('./backup');
const mods = require('./mods');
const { createTelegram } = require('./telegram');
const { createBot, EVENTS: TG_EVENTS } = require('./tgbot');
const { createNet, cleanTunnelAddress } = require('./net');
const { createMonitor } = require('./monitor');
const { restartStep, warnText, localBuild, remoteBuild } = require('./schedule');
const { explain } = require('./diagnose');
const files = require('./files');
const { createDiscord, escapeMd } = require('./discord');
const worlds = require('./worlds');
const extras = require('./extras');
const modtest = require('./modtest');
const { createDiscordBot } = require('./discordbot');
const { weekKey, reportDue, emptyWeek, reportText } = require('./report');

const VERSION = require('../package.json').version;
const MAINT = {
  autoRestart: true,
  backupBeforeStart: true,
  backupEveryHours: 0,
  backupKeep: 10,
  restartEnabled: false,
  restartTime: '05:00',
  autoUpdate: false,
  autostart: false,
  sleepMinutes: 0,
  mirror: '',
  welcome: '',
  messages: [],
};
const SLEEP_MINUTES = [0, 10, 15, 30, 60];
// Где вход и выход игроков в журнале проверены на настоящем сервере: только там можно доверить
// серверу засыпать без игроков (иначе он уснёт посреди игры).
const PLAYERS_RELIABLE = new Set(['terraria', 'rust']);
const APP_PREFS = { closeToTray: true };
const NET = { upnp: false, tunnel: '', tunnelAuto: false };
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const UPDATE_EVERY = 3 * 3600000; // как часто проверять новые версии серверов игр
const HOURS = [0, 1, 2, 3, 6, 12, 24];

function createApp({ dataDir, fetchFn = fetch, emit = () => {}, modtestHoldMs = 30000 }) {
  const store = createStore(dataDir);
  const jobs = new Map(); // id → { pct, text, cancel } — идущая установка
  const busy = new Map(); // id → текст долгой операции (копия, моды)
  const restartAfterExit = new Set();
  const crashes = new Map(); // id → [время падений]
  const stats = new Map(); // id → последний замер нагрузки
  const netState = new Map(); // id → { upnp: { ok, error } } — что получилось при запуске
  const scheduleDone = new Map(); // id → Set уже сделанного по расписанию
  let tgCode = null;
  let lowMemoryWarned = 0;
  const emptySince = new Map(); // id → когда на сервере стало пусто
  const joinedAt = new Map(); // id → Map(имя → время входа) для отчёта
  const runningSince = new Map(); // id → когда сервер запустился (для отчёта)
  const msgSent = new Map(); // id → [время последней отправки каждого сообщения]
  const asleep = new Set(); // серверы, которые уснули сами
  const history = new Map(); // id → [{ t, cpu, mem }] по минутам за 6 часов
  const lastLines = new Map(); // id → журнал прошлого запуска (виден и после остановки)
  const tests = new Map(); // id → идущий поиск сломанного мода

  const net = createNet({ dataDir, fetchFn, log: (text) => emit('toast', { text }) });
  const monitor = createMonitor({
    onSample: (id, s) => {
      stats.set(id, s);
      emit('stats', { id, ...s });
      addHistory(id, s);
      // Памяти почти не осталось: предупреждаем не чаще раза в 10 минут.
      if (s.sysFreeMb / s.sysTotalMb < 0.06 && Date.now() - lowMemoryWarned > 600000) {
        lowMemoryWarned = Date.now();
        const inst = store.get(id);
        emit('toast', { error: true, text: `На компьютере почти закончилась память (свободно ${s.sysFreeMb} МБ). Серверы могут упасть — закройте лишние программы.` });
        if (inst) notify('crash', `⚠️ На компьютере почти закончилась память — свободно ${s.sysFreeMb} МБ.`);
      }
    },
  });

  const gameOf = (inst) => getGame(inst.game);
  const need = (id) => {
    const inst = store.get(id);
    if (!inst) throw new Error('Сервер не найден');
    return inst;
  };
  /** Точка в минуту: средний процессор и наибольшая память за эту минуту. 360 точек — 6 часов. */
  function addHistory(id, s, now = Date.now()) {
    const list = history.get(id) || [];
    history.set(id, list);
    const minute = Math.floor(now / 60000) * 60000;
    const last = list[list.length - 1];
    if (last && last.t === minute) {
      last.n++;
      last.cpu += (s.cpu - last.cpu) / last.n;
      last.mem = Math.max(last.mem, s.memMb);
    } else {
      list.push({ t: minute, cpu: s.cpu, mem: s.memMb, n: 1 });
      if (list.length > 360) list.splice(0, list.length - 360);
    }
  }

  const maintOf = (inst) => ({ ...MAINT, ...(inst.maint || {}) });
  const netOf = (inst) => ({ ...NET, ...(inst.net || {}) });
  const titleOf = (inst) => `${gameOf(inst).title} «${inst.name}»`;

  // ---- события ----

  const runner = createRunner(
    (type, p) => {
      if (type === 'log') return emit('log', p);
      if (type === 'state') {
        const inst = store.get(p.id);
        if (inst && p.state === 'running') notify('start', `🟢 ${titleOf(inst)} запущен.`);
        return pushList();
      }
      if (type === 'player') {
        onPlayer(p);
        const inst = store.get(p.id);
        if (inst) notify('players', `${p.joined ? '➕' : '➖'} ${p.name} ${p.joined ? 'зашёл на' : 'вышел с'} ${titleOf(inst)}. Сейчас игроков: ${p.online}.`);
        return pushList();
      }
      if (type === 'exit') return onExit(p);
    },
    { fetchFn }
  );

  function view(inst) {
    const game = gameOf(inst);
    const dir = store.dir(inst.id);
    const job = jobs.get(inst.id);
    return {
      id: inst.id,
      game: inst.game,
      gameTitle: game.title,
      name: inst.name,
      settings: inst.settings,
      maint: maintOf(inst),
      installed: fs.existsSync(game.exe(dir)),
      state: job ? 'installing' : runner.state(inst.id),
      job: job ? { pct: job.pct, text: job.text } : null,
      busy: busy.get(inst.id) || '',
      players: runner.players(inst.id),
      startedAt: runner.startedAt(inst.id),
      ports: game.ports(inst.settings),
      installedAt: inst.installedAt || 0,
      net: netOf(inst),
      netState: netState.get(inst.id) || null,
      stats: runner.has(inst.id) ? stats.get(inst.id) || null : null,
      lastCrash: inst.lastCrash || null,
      update: inst.updateInfo || null,
      playerActions: Object.keys(game.playerCmds || {}),
      playersNote: game.playersNote || '',
      canSay: !!game.sayCmd && game.console !== 'none',
      canSleep: PLAYERS_RELIABLE.has(inst.game),
      tracksPlayers: !!game.joinRe,
      hasLists: !!(game.lists && game.lists.length),
      asleep: asleep.has(inst.id) && runner.state(inst.id) === 'stopped',
      joinCode: game.joinCode ? game.joinCode(dir) : null,
      joinCodeLabel: game.joinCodeLabel || '',
      worldsImport: worlds.supported(inst.game),
    };
  }
  const listView = () => store.data.instances.map(view);
  const pushList = () => emit('instances', listView());

  async function withBusy(id, text, fn) {
    if (busy.has(id)) throw new Error('Дождитесь конца текущей операции');
    busy.set(id, text);
    pushList();
    try {
      return await fn((t) => {
        busy.set(id, t);
        pushList();
      });
    } finally {
      busy.delete(id);
      pushList();
    }
  }

  // ---- серверы ----

  function usedPorts(exceptId) {
    return store.data.instances.filter((i) => i.id !== exceptId).flatMap((i) => portsOf(gameOf(i), i.settings));
  }

  function create({ game: gameId, name, settings }) {
    const game = getGame(gameId);
    name = cleanText(name, 60) || game.title;
    let s = cleanSettings(game, settings);
    const used = usedPorts();
    if (portsOf(game, s).some((p) => used.includes(p))) {
      const portKey = game.fields.find((f) => f.port).key;
      if (settings && settings[portKey] !== undefined && Number(settings[portKey]) !== defaults(game)[portKey]) {
        throw new Error('Этот порт уже занят другим сервером панели');
      }
      s = freePorts(game, s, used);
    }
    const inst = { id: crypto.randomBytes(5).toString('hex'), game: gameId, name, settings: s, maint: { ...MAINT }, createdAt: Date.now() };
    fs.mkdirSync(store.dir(inst.id), { recursive: true });
    store.data.instances.push(inst);
    store.save();
    pushList();
    return view(inst);
  }

  function update({ id, name, settings, maint }) {
    const inst = need(id);
    const game = gameOf(inst);
    if (name !== undefined) inst.name = cleanText(name, 60) || inst.name;
    if (settings) {
      const s = cleanSettings(game, settings, inst.settings);
      const used = usedPorts(id);
      if (portsOf(game, s).some((p) => used.includes(p))) throw new Error('Этот порт уже занят другим сервером панели');
      inst.settings = s;
    }
    if (maint) {
      const m = { ...maintOf(inst), ...maint };
      const hours = Number(m.backupEveryHours);
      const keep = Number(m.backupKeep);
      if (!HOURS.includes(hours)) throw new Error('Некорректный интервал копий');
      if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new Error('Хранить можно от 1 до 100 копий');
      const time = String(m.restartTime);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Время перезапуска — в формате ЧЧ:ММ');
      inst.maint = {
        autoRestart: !!m.autoRestart,
        backupBeforeStart: !!m.backupBeforeStart,
        backupEveryHours: hours,
        backupKeep: keep,
        restartEnabled: !!m.restartEnabled,
        restartTime: time,
        autoUpdate: !!m.autoUpdate,
        autostart: !!m.autostart,
        sleepMinutes: cleanSleep(m.sleepMinutes, inst),
        mirror: cleanMirror(m.mirror),
        welcome: cleanText(m.welcome, 200),
        messages: cleanMessages(m.messages),
      };
    }
    store.save();
    pushList();
    return { ...view(inst), needsRestart: runner.has(id) && !!settings };
  }

  function cleanSleep(v, inst) {
    const n = Number(v) || 0;
    if (!SLEEP_MINUTES.includes(n)) throw new Error('Засыпать можно через 10, 15, 30 или 60 минут');
    if (n && !PLAYERS_RELIABLE.has(inst.game)) throw new Error('Для этой игры панель пока не умеет надёжно видеть игроков — сон выключен');
    return n;
  }

  function cleanMirror(v) {
    const p = String(v || '').trim();
    if (!p) return '';
    if (!path.isAbsolute(p)) throw new Error('Папка для копий — полный путь, например D:\\Копии');
    if (path.resolve(p).startsWith(path.resolve(dataDir))) throw new Error('Вторая папка должна быть вне папки с серверами — иначе от поломки диска она не спасёт');
    return p;
  }

  function cleanMessages(list) {
    if (!Array.isArray(list)) return [];
    if (list.length > 10) throw new Error('Не больше 10 сообщений по расписанию');
    return list
      .map((x) => ({ every: Number(x.every), text: cleanText(x.text, 200) }))
      .filter((x) => x.text)
      .map((x) => {
        if (!Number.isInteger(x.every) || x.every < 5 || x.every > 1440) throw new Error('Интервал сообщений — от 5 до 1440 минут');
        return x;
      });
  }

  function remove({ id }) {
    need(id);
    if (runner.has(id) || jobs.has(id)) throw new Error('Сначала остановите сервер');
    fs.rmSync(store.dir(id), { recursive: true, force: true, maxRetries: 3 });
    store.data.instances = store.data.instances.filter((i) => i.id !== id);
    store.save();
    pushList();
  }

  // ---- установка и обновление ----

  async function installTerraria(dir, job) {
    job.text = 'Ищу последнюю версию';
    pushList();
    const names = await getJson('https://terraria.org/api/get/dedicated-servers-names', fetchFn);
    const name = Array.isArray(names) ? names.filter((n) => /^terraria-server-\d+\.zip$/.test(n)).sort().pop() : null;
    if (!name) throw new Error('Не удалось узнать последнюю версию сервера Terraria');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-'));
    const ctrl = new AbortController();
    job.cancel = () => ctrl.abort();
    try {
      const zip = path.join(tmp, name);
      let last = 0;
      await download(`https://terraria.org/api/download/pc-dedicated-server/${name}`, zip, {
        fetchFn,
        signal: ctrl.signal,
        onProgress: (got, total) => {
          if (Date.now() - last < 300) return;
          last = Date.now();
          job.pct = total ? Math.round((got / total) * 100) : 0;
          job.text = 'Скачивание';
          emit('install', { id: job.id, pct: job.pct, text: job.text });
        },
      });
      job.text = 'Распаковка';
      pushList();
      const out = path.join(tmp, 'out');
      await unzip(zip, out);
      const ver = fs.readdirSync(out).find((d) => fs.existsSync(path.join(out, d, 'Windows', 'TerrariaServer.exe')));
      if (!ver) throw new Error('В архиве нет сервера для Windows');
      moveInto(path.join(out, ver, 'Windows'), path.join(dir, 'game'));
      return ver;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function installSteam(dir, game, job) {
    job.text = 'Готовлю SteamCMD';
    pushList();
    const exe = await ensureSteamCmd(path.join(dataDir, 'steamcmd'), { fetchFn });
    job.text = 'Подключаюсь к Steam';
    pushList();
    let last = 0;
    const h = appUpdate({
      exe,
      installDir: path.join(dir, 'game'),
      appId: game.install.appId,
      onProgress: (p) => {
        job.pct = Math.round(p.pct);
        job.text = p.stage;
        if (Date.now() - last < 300) return;
        last = Date.now();
        emit('install', { id: job.id, pct: job.pct, text: job.text });
      },
    });
    job.cancel = h.cancel;
    await h.promise;
  }

  /** Поставить или обновить сервер. Отвечает сразу; ход — в событиях install и instances. */
  function install({ id }) {
    installJob(id).catch(() => {});
  }

  /** То же, но с обещанием: выполнится, когда установка закончится (или упадёт). */
  function installJob(id) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    if (runner.has(id)) throw new Error('Сначала остановите сервер');
    if (jobs.has(id)) throw new Error('Установка уже идёт');
    const job = { id, pct: 0, text: 'Подготовка', cancel: null };
    jobs.set(id, job);
    pushList();
    return (async () => {
      const wasInstalled = fs.existsSync(game.exe(dir));
      const fws = ((game.mods || {}).frameworks || []).filter((f) => f.afterUpdate && mods.fwInstalled(dir, f));
      if (wasInstalled) {
        try {
          await createBackup(inst, 'before-update');
        } catch {
          /* мира ещё нет — копировать нечего */
        }
      }
      if (game.install.type === 'steam') await installSteam(dir, game, job);
      else inst.version = await installTerraria(dir, job);
      for (const fw of fws) {
        job.text = `Возвращаю ${fw.title}`;
        pushList();
        await mods.installFramework({ dir, game, id: fw.id, fetchFn });
      }
      inst.installedAt = Date.now();
      inst.updateInfo = { checkedAt: Date.now(), available: false };
      store.save();
      emit('toast', { id, text: wasInstalled ? `${titleOf(inst)}: обновление установлено` : `${titleOf(inst)} установлен — можно запускать` });
    })()
      .catch((e) => {
        emit('toast', { id, error: true, text: `${titleOf(inst)}: ${e.message}` });
        throw e;
      })
      .finally(() => {
        jobs.delete(id);
        pushList();
      });
  }

  function cancelInstall({ id }) {
    const job = jobs.get(id);
    if (job && job.cancel) job.cancel();
  }

  /** Создать копию мира и, если задана вторая папка, положить экземпляр и туда. */
  async function createBackup(inst, reason) {
    const dir = store.dir(inst.id);
    const name = await backup.create(dir, gameOf(inst).saves(inst), reason);
    const m = maintOf(inst);
    backup.prune(dir, m.backupKeep);
    inst.week = { ...emptyWeek(), ...(inst.week || {}) };
    inst.week.backups++;
    if (m.mirror) {
      try {
        const dst = path.join(m.mirror, `${inst.id}-${inst.name.replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}`);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(path.join(dir, 'backups', name), path.join(dst, name));
        // Во второй папке храним столько же автоматических копий, сколько в основной.
        const own = new Set(backup.list(dir).map((b) => b.name));
        for (const f of fs.readdirSync(dst)) if (backup.NAME_RE.test(f) && !own.has(f) && !/_manual\./.test(f)) fs.rmSync(path.join(dst, f), { force: true });
      } catch (e) {
        emit('toast', { id: inst.id, error: true, text: `Копия сохранена, но во вторую папку не записалась: ${e.message}` });
      }
    }
    store.save();
    return name;
  }

  // ---- запуск и остановка ----

  async function start({ id }) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    if (runner.has(id)) throw new Error('Сервер уже запущен');
    if (jobs.has(id)) throw new Error('Дождитесь конца установки');
    if (!fs.existsSync(game.exe(dir))) throw new Error('Сначала установите сервер');
    const mine = portsOf(game, inst.settings);
    const clash = store.data.instances.find((i) => i.id !== id && runner.has(i.id) && portsOf(gameOf(i), i.settings).some((p) => mine.includes(p)));
    if (clash) throw new Error(`Порт занят сервером «${clash.name}». Поменяйте порт в настройках.`);
    if (maintOf(inst).backupBeforeStart) {
      try {
        await createBackup(inst, 'auto');
        emit('backups', { id });
      } catch {
        /* мира ещё нет */
      }
    }
    if (runner.has(id)) return;
    const spec = game.launch({ dir, s: inst.settings });
    runner.start(id, {
      ...spec,
      console: game.console,
      link: game.link ? game.link(inst.settings) : null,
      stopCmd: game.stopCmd,
      readyRe: game.readyRe,
      joinRe: game.joinRe,
      leaveRe: game.leaveRe,
    });
    inst.lastBackupAt = Date.now();
    inst.lastCrash = null;
    store.save();
    monitor.watch(id, runner.pid(id));
    asleep.delete(id);
    runningSince.set(id, Date.now());
    joinedAt.set(id, new Map());
    msgSent.set(id, []);
    emptySince.set(id, Date.now());
    inst.week = { ...emptyWeek(), ...(inst.week || {}) };
    inst.week.starts++;
    const n = netOf(inst);
    netState.delete(id);
    if (n.upnp) {
      net.openFor(id, game.ports(inst.settings), titleOf(inst)).then((r) => {
        netState.set(id, { upnp: r });
        if (!r.ok) emit('toast', { id, error: true, text: `${titleOf(inst)}: не удалось открыть порты на роутере — ${r.error}` });
        pushList();
      });
    }
    if (n.tunnelAuto && n.tunnel) net.playit.ensure(id).catch((e) => emit('toast', { id, error: true, text: 'Туннель playit не запустился: ' + e.message }));
  }

  function stop({ id }) {
    need(id);
    if (!runner.has(id)) throw new Error('Сервер и так выключен');
    restartAfterExit.delete(id);
    runner.stop(id);
  }

  const exitWaiters = new Map(); // id → [resolve] — кто ждёт остановки сервера

  /** Остановить и дождаться, пока процесс завершится. */
  function stopAndWait(id) {
    if (!runner.has(id)) return Promise.resolve();
    const done = new Promise((r) => exitWaiters.set(id, [...(exitWaiters.get(id) || []), r]));
    restartAfterExit.delete(id);
    runner.stop(id);
    return done;
  }

  async function restart({ id }) {
    need(id);
    if (!runner.has(id)) return start({ id });
    restartAfterExit.add(id);
    runner.stop(id);
  }

  function onExit({ id, code, expected, uptime, lines }) {
    lastLines.set(id, (lines || []).slice(-2000));
    closeWeek(id, uptime);
    monitor.unwatch(id);
    stats.delete(id);
    net.closeFor(id).catch(() => {});
    net.playit.release(id);
    netState.delete(id);
    const inst = store.get(id);
    if (!inst) return;
    for (const w of exitWaiters.get(id) || []) w();
    exitWaiters.delete(id);
    if (tests.has(id) && !tests.get(id).done) return; // пробные запуски поиска мода — не падения
    if (restartAfterExit.delete(id)) {
      start({ id }).catch((e) => emit('toast', { id, error: true, text: `${titleOf(inst)}: ${e.message}` }));
      return;
    }
    if (expected || shuttingDown) return notify('stop', asleep.has(id) ? `😴 ${titleOf(inst)} уснул: никого не было. Разбудить — /on в Telegram или кнопкой в панели.` : `⚪ ${titleOf(inst)} остановлен.`);
    // Упал сам. Перезапускаем, но не чаще трёх раз за десять минут.
    const recent = (crashes.get(id) || []).filter((t) => Date.now() - t < 10 * 60000);
    recent.push(Date.now());
    crashes.set(id, recent);
    const again = maintOf(inst).autoRestart && recent.length <= 3 && uptime > 20000;
    const why = explain(lines || [], gameOf(inst).crashHints || []);
    inst.lastCrash = { at: Date.now(), code, early: uptime <= 20000, ...(why || { title: '', advice: '', line: '' }) };
    inst.week = { ...emptyWeek(), ...(inst.week || {}) };
    inst.week.crashes++;
    store.save();
    const reason = why ? ` Похоже: ${why.title.toLowerCase()}.` : '';
    notify('crash', `🔴 ${titleOf(inst)} неожиданно остановился${code ? ` (код ${code})` : ''}.${reason}${again ? ' Запускаю снова.' : ''}`);
    emit('toast', { id, error: true, text: `${titleOf(inst)} неожиданно остановился${why ? ': ' + why.title.toLowerCase() : ''}${again ? ' — запускаю снова' : ''}` });
    pushList();
    if (again) setTimeout(() => start({ id }).catch(() => {}), 5000);
  }

  async function command({ id, text }) {
    need(id);
    return runner.command(id, cleanText(text, 500));
  }

  // ---- копии ----

  async function makeBackup(id, reason) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    return withBusy(id, 'Создаю копию', async () => {
      if (runner.state(id) === 'running' && game.saveCmd) {
        // Просим сервер записать мир на диск, чтобы в копию попало свежее состояние.
        await runner.command(id, game.saveCmd, { echo: false }).catch(() => {});
        await sleep(3000);
      }
      const name = await createBackup(inst, reason);
      inst.lastBackupAt = Date.now();
      emit('backups', { id });
      if (reason !== 'auto') notify('backup', `💾 ${titleOf(inst)}: копия создана.`);
      return name;
    });
  }

  async function restoreBackup({ id, name }) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    if (runner.has(id)) throw new Error('Сначала остановите сервер');
    return withBusy(id, 'Восстанавливаю из копии', async () => {
      await createBackup(inst, 'before-restore').catch(() => {});
      await backup.restore(dir, name, game.saves(inst));
      emit('backups', { id });
    });
  }

  // Перезапуск по расписанию с предупреждением игроков.
  function restartTick(now = new Date()) {
    for (const inst of store.data.instances) {
      const m = maintOf(inst);
      if (!m.restartEnabled || runner.state(inst.id) !== 'running') continue;
      const done = scheduleDone.get(inst.id) || new Set();
      scheduleDone.set(inst.id, done);
      const step = restartStep(now, m.restartTime, done);
      if (!step) continue;
      done.add(step.key);
      const game = gameOf(inst);
      if (step.action === 'warn') {
        if (game.sayCmd && game.console !== 'none') runner.command(inst.id, game.sayCmd(warnText(step.minutes)), { echo: true }).catch(() => {});
      } else {
        notify('stop', `🔄 ${titleOf(inst)}: перезапуск по расписанию.`);
        restart({ id: inst.id }).catch(() => {});
      }
    }
  }

  /** Узнать, вышла ли новая версия сервера игры. Возвращает { available, local, remote }. */
  async function checkUpdate(inst) {
    const game = gameOf(inst);
    const dir = store.dir(inst.id);
    if (!fs.existsSync(game.exe(dir))) return null;
    let info;
    if (game.install.type === 'steam') {
      const exe = await ensureSteamCmd(path.join(dataDir, 'steamcmd'), { fetchFn });
      const local = localBuild(path.join(dir, 'game'), game.install.appId);
      const remote = await remoteBuild(exe, game.install.appId);
      info = { available: !!(local && remote && local !== remote), local, remote };
    } else {
      const names = await getJson('https://terraria.org/api/get/dedicated-servers-names', fetchFn);
      const latest = Array.isArray(names) ? names.filter((n) => /^terraria-server-\d+\.zip$/.test(n)).sort().pop() : null;
      const remote = latest ? latest.replace(/^terraria-server-|\.zip$/g, '') : null;
      info = { available: !!(remote && inst.version && remote !== inst.version), local: inst.version || null, remote };
    }
    inst.updateInfo = { ...info, checkedAt: Date.now() };
    store.save();
    pushList();
    return inst.updateInfo;
  }

  /** Обновить сервер, если вышла новая версия и на нём никого нет. */
  async function autoUpdate(inst) {
    const id = inst.id;
    if (jobs.has(id) || busy.has(id) || !['running', 'stopped'].includes(runner.state(id))) return;
    const info = await checkUpdate(inst);
    if (!info || !info.available) return;
    const wasRunning = runner.has(id);
    if (wasRunning && runner.players(id).length) return; // играют — подождём следующей проверки
    notify('stop', `⬆️ ${titleOf(inst)}: вышло обновление, обновляю сервер.`);
    if (wasRunning) await stopAndWait(id);
    await installJob(id);
    if (wasRunning) await start({ id });
  }

  let updating = false;
  async function updateTick() {
    if (updating) return;
    updating = true;
    try {
      for (const inst of store.data.instances) {
        if (!maintOf(inst).autoUpdate) continue;
        if (Date.now() - ((inst.updateInfo || {}).checkedAt || 0) < UPDATE_EVERY) continue;
        await autoUpdate(inst).catch((e) => emit('toast', { id: inst.id, error: true, text: `${titleOf(inst)}: автообновление не удалось — ${e.message}` }));
      }
    } finally {
      updating = false;
    }
  }

  // ---- игроки, сон, сообщения, отчёт за неделю ----

  function onPlayer({ id, name, joined, online }) {
    const inst = store.get(id);
    if (!inst) return;
    const map = joinedAt.get(id) || new Map();
    joinedAt.set(id, map);
    if (joined) {
      map.set(name, Date.now());
      emptySince.delete(id);
      const m = maintOf(inst);
      const game = gameOf(inst);
      if (m.welcome && game.sayCmd && game.console !== 'none') {
        // Небольшая пауза: сразу после входа игрок ещё не видит чат.
        setTimeout(() => runner.state(id) === 'running' && runner.command(id, game.sayCmd(m.welcome.replace(/\{name\}/g, name)), { echo: true }).catch(() => {}), 8000);
      }
    } else {
      const since = map.get(name);
      map.delete(name);
      if (since) addPlayTime(inst, name, Date.now() - since);
      if (!online) emptySince.set(id, Date.now());
    }
  }

  function addPlayTime(inst, name, ms) {
    inst.week = { ...emptyWeek(), ...(inst.week || {}) };
    inst.week.players[name] = (inst.week.players[name] || 0) + ms;
  }

  /** Сервер остановился: записать в недельный отчёт, сколько он работал и сколько играли. */
  function closeWeek(id, uptimeMs = 0) {
    const inst = store.get(id);
    if (!inst) return;
    inst.week = { ...emptyWeek(), ...(inst.week || {}) };
    const since = runningSince.get(id);
    inst.week.uptimeMs += since ? Date.now() - since : uptimeMs;
    runningSince.delete(id);
    for (const [name, at] of joinedAt.get(id) || []) addPlayTime(inst, name, Date.now() - at);
    joinedAt.delete(id);
    emptySince.delete(id);
    store.save();
  }

  function sleepTick(now = Date.now()) {
    for (const inst of store.data.instances) {
      const min = maintOf(inst).sleepMinutes;
      if (!min || runner.state(inst.id) !== 'running' || busy.has(inst.id) || jobs.has(inst.id) || tests.has(inst.id)) continue;
      if (runner.players(inst.id).length) continue;
      const since = emptySince.get(inst.id);
      if (!since || now - since < min * 60000) continue;
      asleep.add(inst.id);
      restartAfterExit.delete(inst.id);
      runner.stop(inst.id);
    }
  }

  function messagesTick(now = Date.now()) {
    for (const inst of store.data.instances) {
      const m = maintOf(inst);
      const game = gameOf(inst);
      if (!m.messages.length || runner.state(inst.id) !== 'running' || !game.sayCmd || game.console === 'none') continue;
      // Где игроков видно, пустому серверу не пишем.
      if (game.joinRe && !runner.players(inst.id).length) continue;
      const sent = msgSent.get(inst.id) || [];
      msgSent.set(inst.id, sent);
      m.messages.forEach((msg, i) => {
        const last = sent[i] || runningSince.get(inst.id) || runner.startedAt(inst.id) || now;
        if (now - last < msg.every * 60000) return;
        sent[i] = now;
        runner.command(inst.id, game.sayCmd(msg.text), { echo: true }).catch(() => {});
      });
    }
  }

  /** Собрать отчёт: по завершённой неделе или (вручную) по текущей. */
  function weeklyReport() {
    const servers = store.data.instances.map((inst) => {
      const w = { ...emptyWeek(), ...(inst.week || {}), players: { ...((inst.week || {}).players || {}) } };
      // Работающий сейчас сервер: досчитываем текущий сеанс.
      const since = runningSince.get(inst.id) || runner.startedAt(inst.id);
      if (since) w.uptimeMs += Date.now() - since;
      for (const [name, at] of joinedAt.get(inst.id) || []) w.players[name] = (w.players[name] || 0) + (Date.now() - at);
      return { title: titleOf(inst), week: w };
    });
    return reportText(servers);
  }

  function resetWeek() {
    for (const inst of store.data.instances) {
      inst.week = emptyWeek();
      if (runningSince.has(inst.id)) runningSince.set(inst.id, Date.now());
      const map = joinedAt.get(inst.id);
      if (map) for (const k of map.keys()) map.set(k, Date.now());
    }
  }

  async function sendReport(manual) {
    const text = weeklyReport() || (manual ? '📊 За эту неделю серверы не запускались.' : '');
    const c = tgCfg();
    const d = dcCfg();
    if (manual && !c.chatId && !d.url) throw new Error('Сначала подключите Telegram-бота или Discord');
    if (!text) return false;
    if (c.chatId) await tg.send(c.chatId, text);
    if (d.url) discord.send(d.url, escapeMd(text));
    return true;
  }

  function reportTick(now = new Date()) {
    if (!reportDue(now, store.data.lastReportWeek)) return;
    store.data.lastReportWeek = weekKey(now);
    sendReport(false)
      .catch(() => {})
      .finally(() => {
        resetWeek();
        store.save();
      });
  }

  const schedule = setInterval(() => {
    restartTick();
    updateTick();
    sleepTick();
    messagesTick();
    reportTick();
    for (const inst of store.data.instances) {
      const hours = maintOf(inst).backupEveryHours;
      if (!hours || runner.state(inst.id) !== 'running' || busy.has(inst.id)) continue;
      if (Date.now() - (inst.lastBackupAt || 0) < hours * 3600000) continue;
      makeBackup(inst.id, 'schedule').catch(() => {});
    }
  }, 30000);
  schedule.unref();

  // ---- поиск сломанного мода ----

  const TEST_TIMEOUT = 8 * 60000; // дольше этого сервер не может «запускаться»
  const TEST_HOLD = modtestHoldMs; // после запуска ждём ещё полминуты: многие моды падают чуть позже

  /** Первое из обещаний или value через ms; таймер снимается, чтобы не держать программу. */
  function raceTimer(promises, ms, value) {
    let timer;
    const t = new Promise((r) => (timer = setTimeout(() => r(value), ms)));
    return Promise.race([...promises, t]).finally(() => clearTimeout(timer));
  }

  /** Один пробный запуск: true — упал, false — запустился и проработал полминуты. */
  async function trialRun(inst) {
    const id = inst.id;
    const game = gameOf(inst);
    if (!game.readyRe) throw new Error('Панель не умеет видеть, что этот сервер запустился, — поиск невозможен');
    const spec = game.launch({ dir: store.dir(id), s: inst.settings });
    runner.start(id, { ...spec, readyAfterMs: 0, console: game.console, link: game.link ? game.link(inst.settings) : null, stopCmd: game.stopCmd, readyRe: game.readyRe });
    const exited = runner.exited(id).then(() => 'exit');
    const ready = (async () => {
      while (runner.state(id) === 'starting') await sleep(500);
      return runner.state(id) === 'running' ? 'ready' : 'exit';
    })();
    const first = await raceTimer([exited, ready], TEST_TIMEOUT, 'timeout');
    if (first === 'timeout') {
      runner.stop(id);
      await runner.exited(id);
      throw new Error('Сервер слишком долго запускался — поиск остановлен');
    }
    if (first === 'exit') return true;
    const later = await raceTimer([exited], TEST_HOLD, 'ok');
    if (later === 'exit') return true;
    runner.stop(id);
    await runner.exited(id);
    return false;
  }

  async function startModTest({ id }) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    if (runner.has(id) || jobs.has(id) || tests.has(id)) throw new Error('Сначала остановите сервер');
    const mods = modtest.collect(dir, game);
    if (mods.length < 1) throw new Error('На сервере нет модов, которые можно проверить');
    const search = modtest.createSearch(mods);
    const t = { id, total: mods.length, runs: 0, left: search.left(), text: 'Сохраняю мир', cancelled: false, result: null };
    tests.set(id, t);
    const backupName = await createBackup(inst, 'before-modtest');
    modtest.saveState(dir, { backup: backupName });
    const push = () => emit('modtest', { id, ...publicTest(t) });
    (async () => {
      try {
        for (;;) {
          const step = search.next();
          if (step.done) {
            t.result = step;
            break;
          }
          if (t.cancelled) throw new Error('Поиск остановлен');
          t.text = `Пробный запуск ${search.runs + 1}: модов включено ${step.enable.length} из ${mods.length}`;
          t.left = search.left();
          push();
          modtest.apply(dir, game, mods, step.enable);
          const crashed = await trialRun(inst);
          search.report(crashed);
          t.runs = search.runs;
        }
      } catch (e) {
        t.error = e.message;
      } finally {
        if (runner.has(id)) {
          runner.stop(id);
          await runner.exited(id);
        }
        modtest.restoreAll(dir, game);
        // Мир после пробных запусков возвращаем из копии: моды без половины могли его испортить.
        await backup.restore(dir, backupName, game.saves(inst)).catch(() => {});
        modtest.clearState(dir);
        t.done = true;
        t.text = '';
        push();
        const r = t.result || {};
        const name = (k) => (k || '').split('/').pop();
        const msg = t.error ? `Поиск сломанного мода прерван: ${t.error}` : r.noRepro ? 'Со всеми модами сервер запустился — сломанного мода нет' : r.combo ? 'Каждый мод по отдельности работает: сервер ломает сочетание модов' : `Сервер ломает мод «${name(r.culprit)}»`;
        emit('toast', { id, error: !!(t.error || r.culprit), text: `${titleOf(inst)}: ${msg}` });
        setTimeout(() => tests.get(id) === t && tests.delete(id), 10 * 60000).unref();
      }
    })();
    return publicTest(t);
  }

  const publicTest = (t) => ({
    total: t.total,
    runs: t.runs,
    left: t.left,
    text: t.text,
    done: !!t.done,
    error: t.error || '',
    result: t.result ? { ...t.result, culprit: t.result.culprit ? t.result.culprit.split('/').pop() : '', needs: (t.result.needs || []).map((k) => k.split('/').pop()) } : null,
  });

  // Если панель закрыли посреди поиска — вернуть моды и мир при следующем запуске.
  for (const inst of store.data.instances) {
    const dir = store.dir(inst.id);
    const st = modtest.readState(dir);
    if (!st) continue;
    try {
      modtest.restoreAll(dir, gameOf(inst));
      if (st.backup) backup.restore(dir, st.backup, gameOf(inst).saves(inst)).catch(() => {});
    } finally {
      modtest.clearState(dir);
    }
  }

  // ---- игроки ----

  async function playerAction({ id, name, action }) {
    const inst = need(id);
    const game = gameOf(inst);
    const make = (game.playerCmds || {})[action];
    if (!make) throw new Error('Для этой игры такое действие недоступно');
    name = cleanText(name, 40);
    if (!name) throw new Error('Не указан игрок');
    if (runner.state(id) !== 'running') throw new Error('Сервер не запущен');
    return runner.command(id, make(name));
  }

  async function sayAll({ id, text }) {
    const inst = need(id);
    const game = gameOf(inst);
    if (!game.sayCmd || game.console === 'none') throw new Error('У этой игры нет консоли — сообщение отправить нельзя');
    text = cleanText(text, 200);
    if (!text) throw new Error('Напишите текст сообщения');
    if (runner.state(id) !== 'running') throw new Error('Сервер не запущен');
    return runner.command(id, game.sayCmd(text));
  }

  // ---- моды ----

  function modsInfo({ id }) {
    const inst = need(id);
    const game = gameOf(inst);
    const dir = store.dir(id);
    return { frameworks: mods.frameworks(dir, game), folders: mods.folders(dir, game), note: (game.mods || {}).note || '', hasCatalog: !!(game.mods || {}).catalog };
  }

  const modOp = (id, text, fn) => {
    const inst = need(id);
    if (!fs.existsSync(gameOf(inst).exe(store.dir(id)))) throw new Error('Сначала установите сервер');
    if (runner.has(id)) throw new Error('Сначала остановите сервер — моды меняются только на выключенном');
    return withBusy(id, text, (progress) => fn({ dir: store.dir(id), game: gameOf(inst), fetchFn, onProgress: progress })).then(() => modsInfo({ id }));
  };

  async function upload({ id, folder, name, filePath }) {
    return modOp(id, 'Добавляю мод', ({ dir, game }) => mods.addFile({ dir, game, folderId: folder, fileName: name, filePath }));
  }

  // ---- Telegram ----

  const tgCfg = () => ({ token: '', bot: '', chatId: null, chatName: '', control: true, ...store.data.telegram, events: { ...TG_EVENTS, ...((store.data.telegram || {}).events || {}) } });
  const tgWrite = (patch) => {
    store.data.telegram = { ...store.data.telegram, ...patch };
    store.save();
    emit('tg', tgInfo());
  };
  const tg = createTelegram({
    fetchFn,
    onMessage: (m) => bot.onMessage(m),
    onFatal: (msg) => {
      tgWrite({ token: '', bot: '', chatId: null, chatName: '' });
      emit('toast', { error: true, text: 'Telegram-бот отключён: ' + msg });
    },
  });
  const bot = createBot({
    cfg: tgCfg,
    code: () => (tgCode && tgCode.until > Date.now() ? tgCode.code : null),
    link: (chatId, chatName) => {
      tgCode = null;
      tgWrite({ chatId, chatName });
    },
    send: (chatId, text) => tg.send(chatId, text),
    actions: {
      list: listView,
      start: (id) => start({ id }),
      stop: (id) => stop({ id }),
      restart: (id) => restart({ id }),
      backup: (id) => makeBackup(id, 'telegram'),
      command: (id, text) => command({ id, text }),
    },
  });
  const newCode = () => (tgCode = { code: String(crypto.randomInt(100000, 1000000)), until: Date.now() + 10 * 60000 });

  function tgInfo() {
    const c = tgCfg();
    if (c.token && !c.chatId && !(tgCode && tgCode.until > Date.now())) newCode();
    return {
      connected: !!c.token,
      bot: c.bot,
      linked: !!c.chatId,
      chatName: c.chatName,
      control: !!c.control,
      events: c.events,
      code: c.token && !c.chatId ? tgCode.code : null,
    };
  }

  function notify(kind, text) {
    const c = tgCfg();
    if (c.chatId && c.events[kind]) tg.send(c.chatId, text);
    const d = dcCfg();
    if (d.url && d.events[kind]) discord.send(d.url, escapeMd(text));
  }

  // ---- Discord-бот с командами ----

  const dbCfg = () => ({ token: '', name: '', invite: '', control: true, ...(store.data.discordBot || {}) });
  let dbOnline = false;
  const dbInfo = () => {
    const c = dbCfg();
    return { connected: !!c.token, name: c.name, invite: c.invite, control: c.control, online: dbOnline };
  };
  // Команды из Discord разбирает та же логика, что и в Telegram.
  const dcLogic = createBot({
    cfg: () => ({ chatId: 'discord', control: dbCfg().control }),
    code: () => null,
    link: () => {},
    send: async (_chat, text) => dcReply && dcReply(text),
    actions: {
      list: listView,
      start: (id) => start({ id }),
      stop: (id) => stop({ id }),
      restart: (id) => restart({ id }),
      backup: (id) => makeBackup(id, 'telegram'),
      command: (id, text) => command({ id, text }),
    },
  });
  let dcReply = null;
  const dcBot = createDiscordBot({
    fetchFn,
    onCommand: async (text, reply) => {
      dcReply = reply;
      try {
        await dcLogic.onMessage({ text, chat: { id: 'discord' } });
      } finally {
        dcReply = null;
      }
    },
    onState: (s) => {
      dbOnline = !!s.online;
      if (s.fatal) {
        store.data.discordBot = { ...dbCfg(), token: '' };
        store.save();
        emit('toast', { error: true, text: 'Discord-бот отключён: ' + s.fatal });
      }
      emit('dcbot', dbInfo());
    },
  });
  if (dbCfg().token) dcBot.start(dbCfg().token).catch(() => {});

  // ---- Discord ----

  const discord = createDiscord(fetchFn, 'Igrohost');
  const dcCfg = () => ({ url: '', ...store.data.discord, events: { ...TG_EVENTS, ...((store.data.discord || {}).events || {}) } });
  function dcSet({ url, events }) {
    const c = dcCfg();
    const next = { url: c.url, events: { ...c.events } };
    if (url !== undefined) {
      const u = String(url || '').trim();
      if (u && !WEBHOOK_RE.test(u)) throw new Error('Это не похоже на адрес вебхука Discord (https://discord.com/api/webhooks/…)');
      next.url = u;
    }
    for (const k of Object.keys(TG_EVENTS)) if (events && events[k] !== undefined) next.events[k] = !!events[k];
    store.data.discord = next;
    store.save();
    return dcCfg();
  }

  async function tgConnect({ token }) {
    const t = String(token || '').trim();
    const me = await tg.me(t);
    tgWrite({ token: t, bot: me.username, chatId: null, chatName: '' });
    newCode();
    tg.start(t);
    return tgInfo();
  }

  if (tgCfg().token) tg.start(tgCfg().token);

  // Серверы с отметкой «запускать вместе с панелью» — через несколько секунд после старта.
  const autostartTimer = setTimeout(() => {
    for (const inst of store.data.instances) {
      if (!maintOf(inst).autostart || runner.has(inst.id) || !fs.existsSync(gameOf(inst).exe(store.dir(inst.id)))) continue;
      start({ id: inst.id }).catch((e) => emit('toast', { id: inst.id, error: true, text: `${titleOf(inst)}: ${e.message}` }));
    }
  }, 4000);
  autostartTimer.unref();

  // ---- общий вход ----

  // Адреса в домашней сети — первыми; адреса VPN и служебные (198.18.x, 169.254.x) не показываем.
  const lanRank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const addresses = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal && !/^(198\.1[89]\.|169\.254\.)/.test(a.address))
      .map((a) => a.address)
      .sort((a, b) => lanRank(a) - lanRank(b));

  const methods = {
    'app:info': () => ({ version: VERSION, dataDir, games: GAMES.map(publicGame), addresses: addresses(), hours: HOURS }),
    'inst:list': listView,
    'inst:create': create,
    'inst:update': update,
    'inst:delete': remove,
    'inst:install': install,
    'inst:cancelInstall': cancelInstall,
    'inst:start': start,
    'inst:stop': stop,
    'inst:restart': restart,
    'inst:command': command,
    'inst:lines': ({ id }) => (runner.has(need(id).id) ? runner.lines(id) : lastLines.get(id) || []),
    'stats:history': ({ id }) => (history.get(need(id).id) || []).map(({ t, cpu, mem }) => ({ t, cpu: Math.round(cpu * 10) / 10, mem })),
    'inst:folder': ({ id }) => {
      const dir = store.dir(need(id).id);
      spawn(process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    },
    'inst:size': ({ id }) => dirSize(store.dir(need(id).id)),
    'backup:list': ({ id }) => backup.list(store.dir(need(id).id)),
    'backup:create': ({ id }) => makeBackup(id, 'manual'),
    'backup:restore': restoreBackup,
    'backup:delete': ({ id, name }) => {
      backup.remove(store.dir(need(id).id), name);
      emit('backups', { id });
    },
    'mods:get': modsInfo,
    'mods:framework': ({ id, fw }) => modOp(id, 'Ставлю загрузчик модов', (ctx) => mods.installFramework({ ...ctx, id: fw })),
    'mods:frameworkRemove': ({ id, fw }) => modOp(id, 'Удаляю', async (ctx) => mods.removeFramework({ ...ctx, id: fw })),
    'mods:search': ({ id, q }) => mods.search({ game: gameOf(need(id)), q, fetchFn }),
    'mods:install': ({ id, item }) => modOp(id, 'Ставлю мод', (ctx) => mods.installFromCatalog({ ...ctx, itemId: item })),
    'mods:remove': ({ id, folder, name }) => modOp(id, 'Удаляю мод', async ({ dir, game }) => mods.removeItem(dir, game, folder, name)),
    'mods:toggle': ({ id, folder, name }) => modOp(id, 'Переключаю мод', async ({ dir, game }) => mods.toggleItem(dir, game, folder, name)),
    'inst:checkUpdate': ({ id }) => checkUpdate(need(id)),
    'worlds:list': async ({ id }) => worlds.list(need(id).game),
    'worlds:import': async ({ id, key }) => {
      const inst = need(id);
      if (runner.has(id) || jobs.has(id)) throw new Error('Сначала остановите сервер');
      return withBusy(id, 'Переношу мир', async () => {
        await createBackup(inst, 'before-import').catch(() => {});
        const patch = await worlds.importWorld(inst.game, store.dir(id), String(key), inst.settings);
        inst.settings = cleanSettings(gameOf(inst), { ...inst.settings, ...patch }, inst.settings);
        store.save();
        emit('backups', { id });
        return view(inst);
      });
    },
    'mods:checkUpdates': ({ id }) => {
      const inst = need(id);
      return mods.checkUpdates({ dir: store.dir(id), game: gameOf(inst), fetchFn });
    },
    'mods:update': ({ id, items }) =>
      modOp(id, 'Обновляю моды', async (ctx) => {
        const list = Array.isArray(items) ? items.slice(0, 100) : [];
        for (const item of list) {
          ctx.onProgress(`Обновляю ${String(item).split('/').pop()}`);
          await mods.updateFromCatalog({ ...ctx, itemId: String(item) });
        }
      }),
    'report:send': () => sendReport(true),
    'modtest:start': startModTest,
    'modtest:get': ({ id }) => (tests.has(need(id).id) ? publicTest(tests.get(id)) : null),
    'modtest:cancel': ({ id }) => {
      const t = tests.get(need(id).id);
      if (t && !t.done) {
        t.cancelled = true;
        if (runner.has(id)) runner.stop(id);
      }
    },
    'lists:get': ({ id }) => {
      const inst = need(id);
      return extras.lists(store.dir(id), gameOf(inst));
    },
    'lists:edit': ({ id, list, value, add }) => {
      const inst = need(id);
      extras.editList(store.dir(id), gameOf(inst), String(list), value, !!add);
      return { lists: extras.lists(store.dir(id), gameOf(inst)), restart: runner.has(id) };
    },
    'import:detect': ({ path: src }) => {
      const g = extras.detect(String(src || '').trim(), GAMES);
      if (!g) throw new Error('В этой папке не нашлось сервера знакомой игры. Нужна папка, где лежит сам сервер (например, valheim_server.exe)');
      return { game: g.id, title: g.title };
    },
    'import:create': ({ path: src, name }) => {
      src = String(src || '').trim();
      const g = extras.detect(src, GAMES);
      if (!g) throw new Error('В этой папке не нашлось сервера знакомой игры');
      if (path.resolve(src).startsWith(path.resolve(dataDir))) throw new Error('Этот сервер уже в папке панели');
      const v = create({ game: g.id, name: name || g.title });
      const inst = store.get(v.id);
      const job = { id: v.id, pct: 0, text: 'Копирую файлы сервера', cancel: null };
      jobs.set(v.id, job);
      pushList();
      extras
        .copyServer(src, path.join(store.dir(v.id), 'game'))
        .then(() => {
          inst.installedAt = Date.now();
          store.save();
          emit('toast', { id: v.id, text: `${titleOf(inst)}: сервер перенесён — проверьте настройки и запускайте` });
        })
        .catch((e) => emit('toast', { id: v.id, error: true, text: e.message }))
        .finally(() => {
          jobs.delete(v.id);
          pushList();
        });
      return view(inst);
    },
    'invite:text': async ({ id }) => {
      const inst = need(id);
      const game = gameOf(inst);
      const dir = store.dir(id);
      const s = inst.settings;
      const n = netOf(inst);
      const port = game.ports(s)[0].port;
      let internet = n.tunnel || '';
      if (!internet && n.upnp) internet = await net.publicIp().then((ip) => `${ip}:${port}`, () => '');
      const modsList = [];
      if (game.mods && game.mods.catalog && game.mods.catalog.type === 'thunderstore') {
        for (const f of mods.folders(dir, game)) for (const m of f.items) if (m.dir) modsList.push(m.version ? `${m.title} ${m.version}` : m.title);
      }
      return extras.inviteText({
        title: game.title,
        name: inst.name,
        lan: `${addresses()[0] || '127.0.0.1'}:${port}`,
        internet,
        code: game.joinCode ? game.joinCode(dir) : null,
        codeLabel: game.joinCodeLabel,
        password: s.password || '',
        mods: modsList,
        how: game.howToJoin || '',
      });
    },
    'dcbot:get': dbInfo,
    'dcbot:connect': async ({ token }) => {
      const tok = String(token || '').trim();
      const info = await dcBot.start(tok);
      store.data.discordBot = { ...dbCfg(), token: tok, name: info.name, invite: info.invite };
      store.save();
      return dbInfo();
    },
    'dcbot:set': ({ control }) => {
      store.data.discordBot = { ...dbCfg(), control: !!control };
      store.save();
      return dbInfo();
    },
    'dcbot:disconnect': () => {
      dcBot.stop();
      store.data.discordBot = { ...dbCfg(), token: '', name: '', invite: '' };
      store.save();
      dbOnline = false;
      return dbInfo();
    },
    'report:preview': () => weeklyReport(),
    'app:prefs': (patch) => {
      const cur = { ...APP_PREFS, ...(store.data.prefs || {}) };
      if (patch && patch.closeToTray !== undefined) cur.closeToTray = !!patch.closeToTray;
      store.data.prefs = cur;
      store.save();
      return cur;
    },
    'players:action': playerAction,
    'players:say': sayAll,
    'files:list': ({ id }) => {
      const inst = need(id);
      return files.list(store.dir(id), gameOf(inst));
    },
    'files:read': ({ id, path: rel }) => {
      const inst = need(id);
      return files.read(store.dir(id), gameOf(inst), String(rel));
    },
    'files:write': ({ id, path: rel, text }) => {
      const inst = need(id);
      files.write(store.dir(id), gameOf(inst), String(rel), text);
      return { restart: runner.has(id) };
    },
    'net:set': ({ id, upnp, tunnel, tunnelAuto }) => {
      const inst = need(id);
      const n = netOf(inst);
      inst.net = {
        upnp: upnp === undefined ? n.upnp : !!upnp,
        tunnel: tunnel === undefined ? n.tunnel : cleanTunnelAddress(tunnel),
        tunnelAuto: tunnelAuto === undefined ? n.tunnelAuto : !!tunnelAuto,
      };
      store.save();
      pushList();
      return inst.net;
    },
    'net:check': async ({ id }) => {
      const inst = need(id);
      const out = await net.diagnose(gameOf(inst).ports(inst.settings), { upnpEnabled: true });
      return { ...out, opened: net.openedFor(id), running: runner.has(id) };
    },
    'net:playit': () => ({ downloaded: net.playit.downloaded(), running: net.playit.running() }),
    'net:playitSetup': async () => {
      await net.playit.setup();
      return { downloaded: true, running: true };
    },
    'net:playitStop': () => {
      net.playit.stop();
      return { downloaded: net.playit.downloaded(), running: false };
    },
    'dc:get': () => {
      const c = dcCfg();
      return { url: c.url, events: c.events };
    },
    'dc:set': (a) => {
      const c = dcSet(a);
      return { url: c.url, events: c.events };
    },
    'dc:test': async () => {
      const c = dcCfg();
      if (!c.url) throw new Error('Сначала вставьте адрес вебхука');
      await discord.test(c.url, '✅ Проверка: Игрохост на связи.');
    },
    'tg:get': tgInfo,
    'tg:connect': tgConnect,
    'tg:set': ({ events, control }) => {
      const c = tgCfg();
      const ev = { ...c.events };
      for (const k of Object.keys(TG_EVENTS)) if (events && events[k] !== undefined) ev[k] = !!events[k];
      tgWrite({ events: ev, control: control === undefined ? c.control : !!control });
      return tgInfo();
    },
    'tg:test': async () => {
      const c = tgCfg();
      if (!c.chatId) throw new Error('Сначала привяжите чат');
      await tg.send(c.chatId, '✅ Проверка: панель на связи.');
    },
    'tg:disconnect': () => {
      tg.stop();
      tgCode = null;
      tgWrite({ token: '', bot: '', chatId: null, chatName: '' });
      return tgInfo();
    },
  };

  let shuttingDown = false;

  return {
    token: store.data.token,
    store,
    addresses,
    /** Журнал сервера текстом — для кнопки «Скачать журнал». */
    logText(id) {
      need(String(id));
      const lines = runner.has(id) ? runner.lines(id) : lastLines.get(id) || [];
      return lines.map((l) => l.text).join('\r\n') + '\r\n';
    },
    /** Путь к файлу копии для скачивания (имя проверяется). */
    backupFile(id, name) {
      need(String(id));
      const ok = backup.list(store.dir(String(id))).find((b) => b.name === String(name));
      if (!ok) throw new Error('Копия не найдена');
      return path.join(store.dir(String(id)), 'backups', ok.name);
    },
    async call(method, arg) {
      const fn = methods[method];
      if (!fn) throw new Error('Неизвестная команда');
      return fn(arg || {});
    },
    upload,
    runner,
    /** Дополнительные команды от окна программы (например, обновление самой панели). */
    extend(extra) {
      Object.assign(methods, extra);
    },
    emit,
    // для тестов
    _restartTick: restartTick,
    _sleepTick: sleepTick,
    _messagesTick: messagesTick,
    _reportTick: reportTick,
    _weeklyReport: weeklyReport,
    _addHistory: addHistory,
    /** Команда так, как её прислал бы Discord: ответ текстом. */
    async _discordCommand(text) {
      const out = [];
      dcReply = (x) => out.push(x);
      try {
        await dcLogic.onMessage({ text, chat: { id: 'discord' } });
      } finally {
        dcReply = null;
      }
      return out.join('\n');
    },
    _checkUpdate: (id) => checkUpdate(need(id)),
    /** Остановить все серверы (с сохранением мира) перед выходом из панели. */
    async shutdown() {
      shuttingDown = true;
      clearInterval(schedule);
      clearTimeout(autostartTimer);
      dcBot.stop();
      for (const t of tests.values()) t.cancelled = true;
      for (const id of runningSince.keys()) closeWeek(id);
      tg.stop();
      monitor.stop();
      for (const j of jobs.values()) if (j.cancel) j.cancel();
      await runner.stopAll();
      await net.shutdown();
    },
    running: () => store.data.instances.filter((i) => runner.has(i.id)).length,
  };
}

module.exports = { createApp };
