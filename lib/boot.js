// Общий запуск панели для обоих режимов: окно Electron (main.js) и браузер (server.js).
const os = require('os');
const path = require('path');
const { createApp } = require('./app');
const { createHttp } = require('./http');

/**
 * Папка с серверами. SteamCMD не работает с путями, где есть не-латинские буквы,
 * поэтому при русском имени пользователя берём папку в корне диска.
 */
function defaultDataDir() {
  const home = path.join(os.homedir(), 'GameServers');
  if (/^[\x20-\x7e]+$/.test(home)) return home;
  return path.join(process.env.SystemDrive || 'C:', path.sep, 'GameServers');
}

async function boot({ dataDir = defaultDataDir(), port = 0, token } = {}) {
  let web = null;
  const app = createApp({ dataDir, emit: (ch, p) => web && web.emit(ch, p) });
  const key = token || app.token;
  web = createHttp({ app, staticDir: path.join(__dirname, '..', 'renderer'), token: key });
  const actual = await web.listen(port);
  return {
    app,
    dataDir,
    url: `http://127.0.0.1:${actual}/`,
    loginUrl: `http://127.0.0.1:${actual}/?t=${key}`,
    async stop() {
      await app.shutdown();
      web.close();
    },
  };
}

module.exports = { boot, defaultDataDir };
