// Доступ к серверам из интернета:
//  • UPnP — панель сама открывает порты игры на роутере, пока сервер работает;
//  • диагностика — внешний адрес, адрес роутера и «серый» IP провайдера (CGNAT);
//  • туннель playit.gg — для тех, у кого белого IP нет.
// Проверить, что UDP-порт виден снаружи, со своего компьютера нельзя, поэтому проверка честно
// говорит только то, что можно узнать наверняка.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const upnp = require('./upnp');
const { download, getJson } = require('./fetchfile');
const { killTree } = require('./util');

/** Порты, которые нужно открыть наружу (без служебных: RCON, telnet, REST). */
const externalPorts = (ports) => ports.filter((p) => !/наружу/.test(p.what || ''));

/** «Серый» адрес: роутер получил от провайдера частный адрес или не тот, что видит интернет. */
function isCgnat(routerIp, publicIp) {
  if (!routerIp) return false;
  return upnp.isPrivateIp(routerIp) || (!!publicIp && routerIp !== publicIp);
}

const ADDRESS_RE = /^[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?$|^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;

/** Адрес туннеля, который человек скопировал с сайта playit.gg. */
function cleanTunnelAddress(v) {
  const a = String(v || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
  if (a && (a.length > 120 || !ADDRESS_RE.test(a))) throw new Error('Адрес туннеля — вида name.gl.joinmc.link или 147.185.221.1:12345');
  return a;
}

function createNet({ dataDir, fetchFn = fetch, log = () => {}, upnpApi = upnp }) {
  const opened = new Map(); // id → [{ port, proto }]
  const playitDir = path.join(dataDir, 'playit');
  const playitExe = path.join(playitDir, 'playit.exe');
  let playit = null; // { proc, owners: Set<id>, manual }

  async function publicIp() {
    try {
      return (await getJson('https://api.ipify.org?format=json', fetchFn)).ip;
    } catch {
      throw new Error('Не удалось узнать внешний адрес — проверьте подключение к интернету');
    }
  }

  /** Открыть порты сервера на роутере. Возвращает { ok, error, externalIp }. */
  async function openFor(id, ports, title) {
    const list = externalPorts(ports);
    const done = [];
    let externalIp = null;
    try {
      for (const p of list) {
        const r = await upnpApi.openPort(p.port, `${title} (Igrohost)`.slice(0, 60), p.proto);
        externalIp = r.externalIp || externalIp;
        done.push({ port: p.port, proto: p.proto });
      }
      opened.set(id, done);
      return { ok: true, externalIp };
    } catch (e) {
      opened.set(id, done);
      return { ok: false, error: e.message, opened: done.length };
    }
  }

  async function closeFor(id) {
    const list = opened.get(id) || [];
    opened.delete(id);
    for (const p of list) {
      await Promise.race([upnpApi.closePort(p.port, p.proto).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
  }

  /** Что известно о доступе из интернета. */
  async function diagnose(ports, { upnpEnabled }) {
    const out = { publicIp: null, routerIp: null, cgnat: false, upnp: null, upnpError: '', ports: externalPorts(ports) };
    out.publicIp = await publicIp();
    if (upnpEnabled) {
      try {
        out.routerIp = await upnpApi.routerIp();
        out.upnp = true;
      } catch (e) {
        out.upnp = false;
        out.upnpError = e.message;
      }
    }
    out.cgnat = isCgnat(out.routerIp, out.publicIp);
    return out;
  }

  // ---- playit.gg ----

  async function downloadPlayit() {
    if (fs.existsSync(playitExe)) return;
    const rel = await getJson('https://api.github.com/repos/playit-cloud/playit-agent/releases/latest', fetchFn);
    const asset =
      (rel.assets || []).find((a) => a.name === 'playit-windows-x86_64-signed.exe') || (rel.assets || []).find((a) => a.name === 'playit-windows-x86_64.exe');
    if (!asset || !/^https:\/\/github\.com\/playit-cloud\/playit-agent\/releases\/download\//.test(asset.browser_download_url)) {
      throw new Error('Не удалось найти программу playit для Windows');
    }
    log(`Скачиваю playit ${rel.tag_name || ''}…`);
    await download(asset.browser_download_url, playitExe, { fetchFn });
  }

  /** Запустить агент playit. visible — с окном, чтобы человек привязал его к аккаунту. */
  function startPlayit(owner, visible) {
    if (playit) {
      if (owner) playit.owners.add(owner);
      return;
    }
    const proc = spawn(playitExe, [], { cwd: playitDir, detached: !!visible, stdio: 'ignore', windowsHide: !visible });
    const entry = { proc, owners: new Set(owner ? [owner] : []), manual: !!visible };
    playit = entry;
    proc.on('error', (e) => log(`playit не запустился: ${e.message}`));
    proc.on('exit', () => {
      if (playit === entry) playit = null;
    });
  }

  /** Сервер остановился: туннель больше не нужен, если его не держит другой сервер или окно настройки. */
  function releasePlayit(owner) {
    if (!playit) return;
    playit.owners.delete(owner);
    if (playit.owners.size || playit.manual) return;
    stopPlayit();
  }

  function stopPlayit() {
    if (!playit) return;
    killTree(playit.proc.pid);
    playit = null;
  }

  return {
    openFor,
    closeFor,
    openedFor: (id) => opened.get(id) || [],
    diagnose,
    publicIp,
    playit: {
      setup: async () => {
        await downloadPlayit();
        stopPlayit();
        startPlayit(null, true);
      },
      ensure: async (owner) => {
        await downloadPlayit();
        startPlayit(owner, false);
      },
      release: releasePlayit,
      stop: stopPlayit,
      downloaded: () => fs.existsSync(playitExe),
      running: () => !!playit,
    },
    async shutdown() {
      stopPlayit();
      await Promise.all([...opened.keys()].map(closeFor));
    },
  };
}

module.exports = { createNet, externalPorts, isCgnat, cleanTunnelAddress };
