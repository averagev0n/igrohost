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

const VERSION = require('../package.json').version;
const MAINT = { autoRestart: true, backupBeforeStart: true, backupEveryHours: 0, backupKeep: 10, restartEnabled: false, restartTime: '05:00', autoUpdate: false };
const NET = { upnp: false, tunnel: '', tunnelAuto: false };
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const UPDATE_EVERY = 3 * 3600000; // как часто проверять новые версии серверов игр
const HOURS = [0, 1, 2, 3, 6, 12, 24];

function createApp({ dataDir, fetchFn = fetch, emit = () => {} }) {
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

  const net = createNet({ dataDir, fetchFn, log: (text) => emit('toast', { text }) });
  const monitor = createMonitor({
    onSample: (id, s) => {
      stats.set(id, s);
      emit('stats', { id, ...s });
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
      };
    }
    store.save();
    pushList();
    return { ...view(inst), needsRestart: runner.has(id) && !!settings };
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
          await backup.create(dir, game.saves(inst), 'before-update');
          backup.prune(dir, maintOf(inst).backupKeep);
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
        await backup.create(dir, game.saves(inst), 'auto');
        backup.prune(dir, maintOf(inst).backupKeep);
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
    monitor.unwatch(id);
    stats.delete(id);
    net.closeFor(id).catch(() => {});
    net.playit.release(id);
    netState.delete(id);
    const inst = store.get(id);
    if (!inst) return;
    for (const w of exitWaiters.get(id) || []) w();
    exitWaiters.delete(id);
    if (restartAfterExit.delete(id)) {
      start({ id }).catch((e) => emit('toast', { id, error: true, text: `${titleOf(inst)}: ${e.message}` }));
      return;
    }
    if (expected || shuttingDown) return notify('stop', `⚪ ${titleOf(inst)} остановлен.`);
    // Упал сам. Перезапускаем, но не чаще трёх раз за десять минут.
    const recent = (crashes.get(id) || []).filter((t) => Date.now() - t < 10 * 60000);
    recent.push(Date.now());
    crashes.set(id, recent);
    const again = maintOf(inst).autoRestart && recent.length <= 3 && uptime > 20000;
    const why = explain(lines || [], gameOf(inst).crashHints || []);
    inst.lastCrash = { at: Date.now(), code, early: uptime <= 20000, ...(why || { title: '', advice: '', line: '' }) };
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
      const name = await backup.create(dir, game.saves(inst), reason);
      backup.prune(dir, maintOf(inst).backupKeep);
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
      await backup.create(dir, game.saves(inst), 'before-restore').catch(() => {});
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

  const schedule = setInterval(() => {
    restartTick();
    updateTick();
    for (const inst of store.data.instances) {
      const hours = maintOf(inst).backupEveryHours;
      if (!hours || runner.state(inst.id) !== 'running' || busy.has(inst.id)) continue;
      if (Date.now() - (inst.lastBackupAt || 0) < hours * 3600000) continue;
      makeBackup(inst.id, 'schedule').catch(() => {});
    }
  }, 30000);
  schedule.unref();

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
    'inst:lines': ({ id }) => runner.lines(need(id).id),
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
    _checkUpdate: (id) => checkUpdate(need(id)),
    /** Остановить все серверы (с сохранением мира) перед выходом из панели. */
    async shutdown() {
      shuttingDown = true;
      clearInterval(schedule);
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
