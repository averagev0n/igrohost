// Окно программы. Вся работа — в lib/, окно лишь показывает ту же страницу, что и браузер.
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const { boot } = require('./lib/boot');
const { createUpdater } = require('./lib/updater');

let panel = null;
let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  try {
    panel = await boot();
  } catch (e) {
    dialog.showErrorBox('Игрохост', 'Не удалось запустить панель: ' + e.message);
    return app.quit();
  }
  // Обновление самой программы: команды update:* доступны странице через тот же API.
  const updater = createUpdater({ app, shell, emit: (ch, p) => panel.app.emit(ch, p) });
  panel.app.extend(updater.methods);
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Игрохост',
    autoHideMenuBar: true,
    backgroundColor: '#c9652b',
    icon: path.join(__dirname, 'build', 'icon.png'),
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
  win.loadURL(panel.loginUrl);
  win.on('closed', () => (win = null));
});

// Перед выходом мягко останавливаем серверы, чтобы они сохранили миры.
app.on('before-quit', (e) => {
  if (quitting || !panel) return;
  e.preventDefault();
  quitting = true;
  panel
    .stop()
    .catch(() => {})
    .finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
