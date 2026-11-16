// Окно программы. Вся работа — в lib/, окно лишь показывает ту же страницу, что и браузер.
// Закрытое окно не выключает серверы: панель остаётся значком у часов (в трее),
// а выходит только по «Выйти» в меню значка — тогда серверы мягко останавливаются.
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const { boot } = require('./lib/boot');
const { createUpdater } = require('./lib/updater');

const ICON = path.join(__dirname, 'build', 'icon.png');
const startHidden = process.argv.includes('--hidden');

let panel = null;
let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('local.igrohost');

app.on('second-instance', showWindow);

function showWindow() {
  if (!panel) return;
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Игрохост',
    autoHideMenuBar: true,
    backgroundColor: '#c9652b',
    icon: ICON,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Ссылки наружу (справка, сайты модов) открываются в обычном браузере.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(panel.url)) e.preventDefault();
  });
  win.once('ready-to-show', () => win && win.show());
  win.loadURL(panel.loginUrl);
  win.on('close', async (e) => {
    if (quitting) return;
    // Отменять закрытие нужно сразу, до любого ожидания.
    e.preventDefault();
    const prefs = await panel.app.call('app:prefs').catch(() => ({ closeToTray: true }));
    if (!prefs.closeToTray) return quit();
    if (win) win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Игрохост работает в фоне', body: 'Серверы не выключены. Открыть панель — значок у часов. Выйти — правой кнопкой по значку.', icon: ICON }).show();
    }
  });
  win.on('closed', () => (win = null));
}

// ---- мини-окно поверх всех окон ----

let widget = null;

function toggleWidget() {
  if (widget) return closeWidget();
  const store = panel.app.store;
  const pos = (store.data.prefs || {}).widget || {};
  widget = new BrowserWindow({
    width: 300,
    height: 220,
    x: Number.isInteger(pos.x) ? pos.x : undefined,
    y: Number.isInteger(pos.y) ? pos.y : undefined,
    frame: false,
    resizable: true,
    minWidth: 240,
    minHeight: 120,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#2a160b',
    icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  widget.setAlwaysOnTop(true, 'floating');
  widget.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widget.webContents.on('will-navigate', (e) => e.preventDefault());
  // Та же страница-сервер и тот же ключ доступа (cookie), что у главного окна.
  widget.loadURL(panel.url + 'widget.html');
  widget.once('ready-to-show', () => widget && widget.showInactive());
  widget.on('moved', () => {
    if (!widget) return;
    const [x, y] = widget.getPosition();
    store.data.prefs = { ...(store.data.prefs || {}), widget: { x, y } };
    store.save();
  });
  widget.on('closed', () => {
    widget = null;
    refreshTray();
  });
  refreshTray();
}

function closeWidget() {
  if (widget) widget.close();
}

/** Меню значка у часов: что сейчас работает и как выйти. */
async function refreshTray() {
  if (!tray || !panel) return;
  let list = [];
  try {
    list = await panel.app.call('inst:list');
  } catch {
    /* панель останавливается */
  }
  const running = list.filter((i) => i.state !== 'stopped');
  const items = [
    { label: 'Открыть Игрохост', click: showWindow },
    { label: widget ? 'Закрыть мини-окно' : 'Мини-окно поверх всех окон', click: toggleWidget },
    { type: 'separator' },
    ...(running.length
      ? running.map((i) => ({ label: `${i.gameTitle} «${i.name}» — ${i.players.length ? `${i.players.length} в игре` : 'работает'}`, enabled: false }))
      : [{ label: 'Все серверы выключены', enabled: false }]),
    { type: 'separator' },
    { label: running.length ? 'Выйти и остановить серверы' : 'Выйти', click: quit },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(running.length ? `Игрохост — работает серверов: ${running.length}` : 'Игрохост');
}

function quit() {
  quitting = true;
  app.quit();
}

app.whenReady().then(async () => {
  try {
    panel = await boot();
  } catch (e) {
    dialog.showErrorBox('Игрохост', 'Не удалось запустить панель: ' + e.message);
    return app.quit();
  }
  const updater = createUpdater({ app, shell, emit: (ch, p) => panel.app.emit(ch, p) });
  panel.app.extend({
    ...updater.methods,
    // Запуск вместе с Windows: окно не открывается, панель сразу уходит в трей.
    'app:login': ({ enabled } = {}) => {
      if (enabled !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
      return { enabled: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin, available: app.isPackaged };
    },
    'app:widget': ({ close } = {}) => (close ? closeWidget() : toggleWidget()),
    'app:showMain': () => showWindow(),
    'app:pickFolder': async () => {
      const r = await dialog.showOpenDialog(win || undefined, { properties: ['openDirectory', 'createDirectory'], title: 'Папка для копий' });
      return r.canceled ? null : r.filePaths[0];
    },
  });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTray();
  setInterval(refreshTray, 5000).unref();

  createWindow();
  if (startHidden) win.once('ready-to-show', () => win && win.hide());
});

// Перед выходом мягко останавливаем серверы, чтобы они сохранили миры.
app.on('before-quit', (e) => {
  quitting = true;
  if (!panel) return;
  e.preventDefault();
  const p = panel;
  panel = null;
  if (tray) tray.setToolTip('Игрохост — останавливаю серверы…');
  p.stop()
    .catch(() => {})
    .finally(() => {
      if (tray) tray.destroy();
      app.exit(0);
    });
});

// Окно закрыто, а панель живёт в трее — не выходим.
app.on('window-all-closed', () => {});
