// Обновление самой программы с GitHub Releases (только в собранной программе).
// Установленная версия скачивает и ставит обновление сама (electron-updater),
// портативная — показывает, что вышло, и открывает страницу загрузки.
const fs = require('fs');
const path = require('path');
const { getJson } = require('./fetchfile');

const REPO = { owner: 'averagev0n', repo: 'igrohost' };
const releasesApi = () => `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases`;
const releasePage = (v) => `https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/v${v}`;

/** Сравнить версии «1.2.10» и «1.2.9». */
function cmpVer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Описание версии из CHANGELOG.md, который едет внутри программы. */
function changelogNotes(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text).match(new RegExp(`^## ${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  return m ? m[1].trim() : '';
}

function createUpdater({ app, shell, emit }) {
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const enabled = app.isPackaged;
  let autoUpdater = null;
  let state = { status: enabled ? 'idle' : 'off', version: app.getVersion() };
  let checking = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    emit('update', state);
  };

  async function releaseNotes(version) {
    try {
      const r = await getJson(`${releasesApi()}/tags/v${encodeURIComponent(version)}`);
      return typeof r.body === 'string' ? r.body : '';
    } catch {
      return '';
    }
  }

  async function check(manual) {
    if (!enabled || checking || ['downloading', 'ready'].includes(state.status)) return state;
    checking = true;
    set({ status: 'checking', manual: !!manual });
    try {
      if (isPortable) {
        const r = await getJson(`${releasesApi()}/latest`);
        const latest = String(r.tag_name || '').replace(/^v/, '');
        if (latest && cmpVer(latest, app.getVersion()) > 0) set({ status: 'available', latest, notes: r.body || '', mode: 'portable' });
        else set({ status: 'none' });
      } else {
        const res = await autoUpdater.checkForUpdates();
        const v = res && res.updateInfo && res.updateInfo.version;
        if (!v || cmpVer(v, app.getVersion()) <= 0) set({ status: 'none' });
      }
    } catch (e) {
      // Без интернета или пока выпусков нет — молчим, если проверка была фоновой.
      set({ status: manual ? 'error' : 'idle', error: String((e && e.message) || e).split('\n')[0] });
    } finally {
      checking = false;
    }
    return state;
  }

  async function download() {
    if (state.status !== 'available') throw new Error('Нет доступного обновления');
    if (state.mode === 'portable') return shell.openExternal(releasePage(state.latest));
    set({ status: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate().catch((e) => set({ status: 'error', error: String(e.message).split('\n')[0] }));
  }

  function install() {
    if (state.status !== 'ready') throw new Error('Обновление ещё не скачано');
    autoUpdater.quitAndInstall(false, true);
  }

  /** «Что нового» один раз после обновления. */
  function whatsNew() {
    const file = path.join(app.getPath('userData'), 'last-version.txt');
    let last = null;
    try {
      last = fs.readFileSync(file, 'utf8').trim();
    } catch {
      /* первый запуск */
    }
    const cur = app.getVersion();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, cur);
    } catch {
      /* не критично */
    }
    if (!last || cmpVer(cur, last) <= 0) return null;
    try {
      return { version: cur, notes: changelogNotes(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), cur) };
    } catch {
      return { version: cur, notes: '' };
    }
  }

  if (enabled) {
    if (!isPortable) {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', async (info) => set({ status: 'available', latest: info.version, notes: await releaseNotes(info.version), mode: 'install' }));
      autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
      autoUpdater.on('update-downloaded', () => set({ status: 'ready' }));
      autoUpdater.on('error', (e) => {
        if (state.status === 'downloading') set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] });
      });
    }
    setTimeout(() => check(false), 8000).unref();
    setInterval(() => check(false), 6 * 3600000).unref();
  }

  const news = enabled ? whatsNew() : null;

  return {
    methods: {
      'update:state': () => ({ ...state, news }),
      'update:check': () => check(true),
      'update:download': download,
      'update:install': install,
    },
  };
}

module.exports = { createUpdater, cmpVer, changelogNotes, REPO };
