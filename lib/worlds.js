// Миры из одиночной игры на этом компьютере → на сервер.
// Поддерживаются игры, у которых мир — один-два файла в известном месте:
//  • Valheim     — LocalLow\IronGate\Valheim\worlds_local\<имя>.fwl + .db;
//  • Terraria    — Документы\My Games\Terraria\Worlds\<имя>.wld;
//  • Core Keeper — LocalLow\Pugstorm\Core Keeper\Steam\<id>\worlds\<номер>.world.gzip.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./util');

let documentsCache = null;
/** Папка «Документы» (её часто переносят в OneDrive). */
async function documentsDir() {
  if (documentsCache) return documentsCache;
  let dir = path.join(os.homedir(), 'Documents');
  if (process.platform === 'win32') {
    try {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyDocuments')"]);
      const out = r.out.trim();
      if (r.code === 0 && out && fs.existsSync(out)) dir = out;
    } catch {
      /* берём обычную папку */
    }
  }
  documentsCache = dir;
  return dir;
}

const localLow = (home) => path.join(home, 'AppData', 'LocalLow');
const ls = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const stat = (f) => {
  try {
    return fs.statSync(f);
  } catch {
    return null;
  }
};

const FINDERS = {
  async valheim({ home }) {
    const out = [];
    for (const sub of ['worlds_local', 'worlds']) {
      const dir = path.join(localLow(home), 'IronGate', 'Valheim', sub);
      for (const e of ls(dir)) {
        const m = /^(.+)\.fwl$/i.exec(e.name);
        if (!m) continue;
        const db = stat(path.join(dir, m[1] + '.db'));
        if (!db) continue;
        out.push({ key: path.join(dir, e.name), name: m[1], mtime: db.mtimeMs, size: db.size, where: sub === 'worlds' ? 'облако Steam' : '' });
      }
    }
    return out;
  },
  async terraria({ docs }) {
    const dir = path.join(docs, 'My Games', 'Terraria', 'Worlds');
    return ls(dir)
      .filter((e) => /\.wld$/i.test(e.name))
      .map((e) => {
        const st = stat(path.join(dir, e.name));
        return { key: path.join(dir, e.name), name: e.name.replace(/\.wld$/i, ''), mtime: st.mtimeMs, size: st.size, where: '' };
      });
  },
  async corekeeper({ home }) {
    const base = path.join(localLow(home), 'Pugstorm', 'Core Keeper', 'Steam');
    const out = [];
    for (const acc of ls(base).filter((e) => e.isDirectory())) {
      const dir = path.join(base, acc.name, 'worlds');
      for (const e of ls(dir)) {
        const m = /^(\d+)\.world\.gzip$/i.exec(e.name);
        if (!m) continue;
        const st = stat(path.join(dir, e.name));
        out.push({ key: path.join(dir, e.name), name: `Мир №${Number(m[1]) + 1}`, mtime: st.mtimeMs, size: st.size, where: '' });
      }
    }
    return out;
  },
};

const IMPORTERS = {
  /** Valheim берёт мир по имени из настроек (-world). */
  valheim(dir, key) {
    const name = path.basename(key).replace(/\.fwl$/i, '');
    if (!/^[^\\/:*?"<>|]{1,40}$/.test(name)) throw new Error('У мира необычное имя — переименуйте его в игре');
    const dst = path.join(dir, 'saves', 'worlds_local');
    fs.mkdirSync(dst, { recursive: true });
    for (const ext of ['.fwl', '.db']) fs.copyFileSync(key.replace(/\.fwl$/i, ext), path.join(dst, name + ext));
    return { world: name };
  },
  terraria(dir, key) {
    const name = path.basename(key).replace(/\.wld$/i, '');
    if (!/^[^\\/:*?"<>|]{1,40}$/.test(name)) throw new Error('У мира необычное имя — переименуйте его в игре');
    fs.mkdirSync(path.join(dir, 'worlds'), { recursive: true });
    fs.copyFileSync(key, path.join(dir, 'worlds', name + '.wld'));
    return { worldname: name };
  },
  /** Core Keeper: мир кладём под номером из настроек сервера, номер у сервера свой. */
  corekeeper(dir, key, s) {
    const index = Number(s.world) || 0;
    fs.mkdirSync(path.join(dir, 'saves', 'worlds'), { recursive: true });
    fs.copyFileSync(key, path.join(dir, 'saves', 'worlds', `${index}.world.gzip`));
    return {};
  },
};

const supported = (gameId) => !!FINDERS[gameId];

async function list(gameId, { home = os.homedir(), docs } = {}) {
  if (!FINDERS[gameId]) return [];
  const worlds = await FINDERS[gameId]({ home, docs: docs || (await documentsDir()) });
  return worlds.sort((a, b) => b.mtime - a.mtime);
}

/** Скопировать мир на сервер. key должен быть из list() — чужие пути не принимаем. Возвращает новые настройки. */
async function importWorld(gameId, dir, key, settings, opts = {}) {
  const found = (await list(gameId, opts)).find((w) => w.key === key);
  if (!found) throw new Error('Мир не найден — обновите список');
  return IMPORTERS[gameId](dir, key, settings);
}

module.exports = { list, importWorld, supported };
