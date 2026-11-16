// Общий запуск панели для обоих режимов: окно Electron (main.js) и браузер (server.js).
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createApp } = require('./app');
const { createHttp } = require('./http');

const REMOTE_PORT = 8791;
const MAX_SESSIONS = 20;

/**
 * Папка с серверами. SteamCMD не работает с путями, где есть не-латинские буквы,
 * поэтому при русском имени пользователя берём папку в корне диска.
 */
function defaultDataDir() {
  const home = path.join(os.homedir(), 'GameServers');
  if (/^[\x20-\x7e]+$/.test(home)) return home;
  return path.join(process.env.SystemDrive || 'C:', path.sep, 'GameServers');
}

const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

async function boot({ dataDir = defaultDataDir(), port = 0, token } = {}) {
  let web = null;
  const app = createApp({ dataDir, emit: (ch, p) => web && web.emit(ch, p) });
  const key = token || app.token;
  const store = app.store;

  // ---- доступ с телефона ----
  const rcfg = () => ({ enabled: false, port: REMOTE_PORT, pin: '', sessions: [], ...(store.data.remote || {}) });
  const rsave = (patch) => {
    store.data.remote = { ...rcfg(), ...patch };
    store.save();
  };
  if (!rcfg().pin) rsave({ pin: newPin() });

  web = createHttp({
    app,
    staticDir: path.join(__dirname, '..', 'renderer'),
    token: key,
    remote: {
      pin: () => (rcfg().enabled ? rcfg().pin : null),
      hasSession: (h) => rcfg().sessions.includes(h),
      addSession: (h) => rsave({ sessions: [...rcfg().sessions, h].slice(-MAX_SESSIONS) }),
    },
  });
  const actual = await web.listen(port);

  const remoteInfo = () => {
    const c = rcfg();
    const running = web.remotePort();
    return {
      enabled: c.enabled,
      running: !!running,
      port: c.port,
      pin: c.pin,
      devices: c.sessions.length,
      urls: running ? app.addresses().map((ip) => `http://${ip}:${running}/`) : [],
    };
  };

  async function applyRemote() {
    const c = rcfg();
    web.closeRemote();
    if (c.enabled) await web.listenRemote(c.port);
  }

  app.extend({
    'remote:get': remoteInfo,
    'remote:set': async ({ enabled, port: p }) => {
      const c = rcfg();
      const nextPort = p === undefined ? c.port : Number(p);
      if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) throw new Error('Порт — от 1024 до 65535');
      rsave({ enabled: enabled === undefined ? c.enabled : !!enabled, port: nextPort });
      try {
        await applyRemote();
      } catch (e) {
        rsave({ enabled: false });
        throw e;
      }
      return remoteInfo();
    },
    // Новый ПИН-код выходит из всех телефонов: старые входы больше не действуют.
    'remote:newPin': () => {
      rsave({ pin: newPin(), sessions: [] });
      return remoteInfo();
    },
  });

  if (rcfg().enabled) {
    await applyRemote().catch((e) => {
      rsave({ enabled: false });
      setTimeout(() => app.emit('toast', { error: true, text: e.message }), 3000);
    });
  }

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
