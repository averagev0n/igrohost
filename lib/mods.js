// Моды и плагины: загрузчики (BepInEx, Oxide, Metamod…), папки с модами и каталоги.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { download, unzip, getJson } = require('./fetchfile');
const { findFile, moveInto, dirSize } = require('./util');

const NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/;
const SLUG_RE = /^[\w.-]{1,100}$/;

function safeName(name) {
  name = path.basename(String(name || ''));
  if (!NAME_RE.test(name) || name === '.' || name === '..') throw new Error('Некорректное имя файла');
  return name;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'igrohost-'));
const fwInstalled = (dir, fw) => fs.existsSync(path.join(dir, fw.marker));
const getFw = (game, id) => {
  const fw = ((game.mods || {}).frameworks || []).find((f) => f.id === id);
  if (!fw) throw new Error('Неизвестный загрузчик модов');
  return fw;
};

// ---- загрузчики ----

async function githubAsset(source, fetchFn) {
  const rel = await getJson(`https://api.github.com/repos/${source.repo}/releases/latest`, fetchFn);
  const asset = (rel.assets || []).find((a) => source.asset.test(a.name));
  if (!asset) throw new Error('В последнем выпуске нет файла для Windows');
  return { url: asset.browser_download_url, version: rel.tag_name };
}

async function metamodAsset(source, fetchFn) {
  const res = await fetchFn(source.base + source.latest, { headers: { 'User-Agent': 'igrohost' } });
  const name = res.ok ? (await res.text()).trim() : '';
  if (!/^mmsource-[\w.-]+\.zip$/.test(name)) throw new Error('Не удалось узнать последнюю версию Metamod');
  return { url: source.base + name, version: name.replace(/^mmsource-|-windows\.zip$/g, '') };
}

/** Поставить (или обновить) загрузчик. Возвращает версию. */
async function installFramework({ dir, game, id, fetchFn = fetch, onProgress = () => {} }) {
  const fw = getFw(game, id);
  if (fw.requires && !fwInstalled(dir, getFw(game, fw.requires))) {
    await installFramework({ dir, game, id: fw.requires, fetchFn, onProgress });
  }
  if (fw.source.type === 'thunderstore') {
    return installThunderstore({ dir, catalog: game.mods.catalog, namespace: fw.source.namespace, name: fw.source.name, fetchFn, onProgress, force: true });
  }
  onProgress(`${fw.title}: ищу последнюю версию`);
  const a = fw.source.type === 'metamod' ? await metamodAsset(fw.source, fetchFn) : await githubAsset(fw.source, fetchFn);
  const tmp = tmpDir();
  try {
    const zip = path.join(tmp, 'fw.zip');
    await download(a.url, zip, { fetchFn, onProgress: (got, total) => onProgress(`${fw.title}: скачивание${total ? ` ${Math.round((got / total) * 100)}%` : ''}`) });
    const out = path.join(tmp, 'out');
    onProgress(`${fw.title}: распаковка`);
    await unzip(zip, out);
    let root = out;
    if (fw.flatten) {
      const hit = findFile(out, fw.flatten, 3);
      if (!hit) throw new Error(`В архиве нет файла ${fw.flatten}`);
      root = path.dirname(hit);
    }
    moveInto(root, path.join(dir, fw.target));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return a.version;
}

function removeFramework({ dir, game, id }) {
  const fw = getFw(game, id);
  if (!fw.removable) throw new Error('Этот загрузчик убирается только переустановкой сервера');
  fs.rmSync(path.join(dir, fw.target), { recursive: true, force: true });
}

function frameworks(dir, game) {
  return ((game.mods || {}).frameworks || []).map((fw) => ({
    id: fw.id,
    title: fw.title,
    about: fw.about,
    installed: fwInstalled(dir, fw),
    removable: !!fw.removable,
  }));
}

// ---- папки с модами ----

function getFolder(game, id) {
  const f = ((game.mods || {}).folders || []).find((x) => x.id === id);
  if (!f) throw new Error('Неизвестная папка модов');
  return f;
}

function readVersion(itemDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(itemDir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    return m.version_number || m.version || '';
  } catch {
    return '';
  }
}

function listFolder(dir, folder) {
  const base = path.join(dir, folder.path);
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const e of entries) {
    if (folder.keep && folder.keep.test(e.name)) continue;
    const full = path.join(base, e.name);
    if (e.isDirectory()) {
      if (!folder.dirs) continue;
      items.push({ name: e.name, title: e.name, dir: true, enabled: true, size: dirSize(full), version: readVersion(full) });
    } else {
      const off = e.name.endsWith('.disabled');
      const real = off ? e.name.slice(0, -9) : e.name;
      if (!(folder.exts || []).includes(path.extname(real).toLowerCase())) continue;
      items.push({ name: e.name, title: real, dir: false, enabled: !off, size: fs.statSync(full).size, version: '' });
    }
  }
  return items.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

function folders(dir, game) {
  const fws = (game.mods || {}).frameworks || [];
  return ((game.mods || {}).folders || []).map((f) => {
    const need = f.needs ? fws.find((x) => x.id === f.needs) : null;
    const accept = [...(f.exts || [])];
    if (f.zip === 'dir' || accept.length) accept.push('.zip');
    return {
      id: f.id,
      title: f.title,
      needs: need && !fwInstalled(dir, need) ? need.title : '',
      accept,
      items: listFolder(dir, f),
    };
  });
}

function findItem(dir, game, folderId, name) {
  const folder = getFolder(game, folderId);
  name = safeName(name);
  if (!listFolder(dir, folder).some((i) => i.name === name)) throw new Error('Мод не найден');
  return path.join(dir, folder.path, name);
}

function removeItem(dir, game, folderId, name) {
  fs.rmSync(findItem(dir, game, folderId, name), { recursive: true, force: true });
}

/** Выключить или включить мод-файл (переименованием в .disabled). */
function toggleItem(dir, game, folderId, name) {
  const p = findItem(dir, game, folderId, name);
  if (fs.statSync(p).isDirectory()) throw new Error('Мод-папку можно только удалить');
  fs.renameSync(p, p.endsWith('.disabled') ? p.slice(0, -9) : p + '.disabled');
}

function walk(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

/** Добавить мод из файла, который пользователь выбрал на своём диске. */
async function addFile({ dir, game, folderId, fileName, filePath }) {
  const folder = getFolder(game, folderId);
  const name = safeName(fileName);
  const ext = path.extname(name).toLowerCase();
  const base = path.join(dir, folder.path);
  const exts = folder.exts || [];
  if (exts.includes(ext)) {
    fs.mkdirSync(base, { recursive: true });
    fs.copyFileSync(filePath, path.join(base, name));
    return { added: [name] };
  }
  if (ext !== '.zip') throw new Error(`Сюда подходят файлы: ${[...exts, '.zip'].join(', ')}`);
  const tmp = tmpDir();
  try {
    await unzip(filePath, tmp);
    const top = fs.readdirSync(tmp, { withFileTypes: true });
    if (!top.length) throw new Error('Архив пуст');
    if (folder.zip === 'dir') {
      // Архив собран от корня игры (внутри папка addons) — кладём как есть.
      if (folder.zipRoot && top.some((e) => e.isDirectory() && e.name.toLowerCase() === folder.zipRoot.marker)) {
        moveInto(tmp, path.join(dir, folder.zipRoot.root));
        return { added: [name] };
      }
      const single = top.length === 1 && top[0].isDirectory() ? top[0].name : null;
      const target = safeName(single || path.basename(name, '.zip'));
      moveInto(single ? path.join(tmp, single) : tmp, path.join(base, target));
      return { added: [target] };
    }
    const hits = walk(tmp).filter((f) => exts.includes(path.extname(f).toLowerCase()));
    if (!hits.length) throw new Error(`В архиве нет файлов ${exts.join(', ')}`);
    fs.mkdirSync(base, { recursive: true });
    for (const f of hits) fs.copyFileSync(path.join(tmp, f), path.join(base, safeName(f)));
    return { added: hits.map((f) => path.basename(f)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- каталог Thunderstore (Valheim) ----

const TS_DIRS = { plugins: 'plugins', patchers: 'patchers', config: 'config', monomod: 'monomod', core: 'core' };

/**
 * Куда положить файлы мода с Thunderstore. files — пути внутри архива, fullName — «Автор-Мод».
 * Возвращает [{ from, to }], to — относительно корня игры.
 */
function planThunderstore(files, fullName, pack) {
  const packPrefix = pack + '/';
  if (files.some((f) => f.startsWith(packPrefix))) {
    return files.filter((f) => f.startsWith(packPrefix)).map((f) => ({ from: f, to: f.slice(packPrefix.length) }));
  }
  return files.map((f) => {
    const parts = f.split('/');
    if (parts[0].toLowerCase() === 'bepinex' && parts.length > 1) parts.shift();
    const kind = TS_DIRS[parts[0].toLowerCase()];
    if (kind && parts.length > 1) {
      const rest = parts.slice(1).join('/');
      return { from: f, to: kind === 'config' ? `BepInEx/config/${rest}` : `BepInEx/${kind}/${fullName}/${rest}` };
    }
    return { from: f, to: `BepInEx/plugins/${fullName}/${parts.join('/')}` };
  });
}

async function installThunderstore({ dir, catalog, namespace, name, fetchFn = fetch, onProgress = () => {}, force = false, seen = new Set() }) {
  if (!SLUG_RE.test(namespace) || !SLUG_RE.test(name)) throw new Error('Некорректное имя мода');
  const fullName = `${namespace}-${name}`;
  if (seen.has(fullName)) return '';
  seen.add(fullName);
  const root = path.join(dir, catalog.root);
  const isPack = name === catalog.pack;
  if (isPack && !force && fs.existsSync(path.join(root, 'BepInEx', 'core'))) return '';
  onProgress(`${name}: ищу последнюю версию`);
  const pkg = await getJson(`https://thunderstore.io/api/experimental/package/${namespace}/${name}/`, fetchFn);
  const latest = pkg.latest || {};
  for (const dep of latest.dependencies || []) {
    const m = /^(.+?)-([^-]+)-\d+\.\d+\.\d+$/.exec(dep);
    if (m) await installThunderstore({ dir, catalog, namespace: m[1], name: m[2], fetchFn, onProgress, seen });
  }
  const tmp = tmpDir();
  try {
    const zip = path.join(tmp, 'mod.zip');
    await download(latest.download_url, zip, { fetchFn, onProgress: (got, total) => onProgress(`${name}: скачивание${total ? ` ${Math.round((got / total) * 100)}%` : ''}`) });
    const out = path.join(tmp, 'out');
    await unzip(zip, out);
    if (!isPack) fs.rmSync(path.join(root, 'BepInEx', 'plugins', fullName), { recursive: true, force: true });
    for (const { from, to } of planThunderstore(walk(out), fullName, catalog.pack)) {
      const dst = path.join(root, to);
      if (!dst.startsWith(root + path.sep)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(out, from), dst);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return latest.version_number || '';
}

async function searchThunderstore(catalog, q, fetchFn) {
  const url = `https://thunderstore.io/api/cyberstorm/listing/${catalog.community}/?ordering=most-downloaded&q=${encodeURIComponent(q)}`;
  const j = await getJson(url, fetchFn);
  return (j.results || [])
    .filter((r) => !r.is_deprecated && r.name !== catalog.pack && !(r.categories || []).some((c) => c.slug === 'modpacks'))
    .slice(0, 30)
    .map((r) => {
      const cats = (r.categories || []).map((c) => c.slug);
      return {
        id: `${r.namespace}/${r.name}`,
        title: r.name.replace(/_/g, ' '),
        author: r.namespace,
        desc: r.description || '',
        downloads: r.download_count || 0,
        note: cats.includes('client-side') && !cats.includes('server-side') ? 'Только для игроков — на сервере не нужен' : '',
      };
    });
}

// ---- каталог uMod (Rust) ----

async function searchUmod(catalog, q, fetchFn) {
  const url = `https://umod.org/plugins/search.json?query=${encodeURIComponent(q)}&page=1&sort=downloads&sortdir=desc&categories%5B%5D=${catalog.game}`;
  const j = await getJson(url, fetchFn);
  return (j.data || [])
    .filter((p) => /^https:\/\/umod\.org\/plugins\/[\w.-]+\.cs$/.test(p.download_url || ''))
    .slice(0, 30)
    .map((p) => ({
      id: path.basename(p.download_url),
      title: p.title,
      author: p.author || '',
      desc: p.description || '',
      downloads: p.downloads || 0,
      version: p.latest_release_version_formatted || '',
      note: '',
    }));
}

async function search({ game, q, fetchFn = fetch }) {
  const c = (game.mods || {}).catalog;
  if (!c) throw new Error('У этой игры нет каталога модов');
  q = String(q || '').trim().slice(0, 60);
  return c.type === 'umod' ? searchUmod(c, q, fetchFn) : searchThunderstore(c, q, fetchFn);
}

async function installFromCatalog({ dir, game, itemId, fetchFn = fetch, onProgress = () => {} }) {
  const c = (game.mods || {}).catalog;
  if (!c) throw new Error('У этой игры нет каталога модов');
  if (c.type === 'umod') {
    if (!/^[\w.-]+\.cs$/.test(itemId)) throw new Error('Некорректное имя плагина');
    if (c.needs && !fwInstalled(dir, getFw(game, c.needs))) await installFramework({ dir, game, id: c.needs, fetchFn, onProgress });
    onProgress(`${itemId}: скачивание`);
    await download(`https://umod.org/plugins/${itemId}`, path.join(dir, c.folder, itemId), { fetchFn });
    return;
  }
  const [namespace, name] = String(itemId).split('/');
  // Загрузчик ставится первым, даже если мод не указал его в зависимостях.
  const packFw = game.mods.frameworks.find((f) => f.source.type === 'thunderstore');
  if (packFw && !fwInstalled(dir, packFw)) await installFramework({ dir, game, id: packFw.id, fetchFn, onProgress });
  await installThunderstore({ dir, catalog: c, namespace, name: name || '', fetchFn, onProgress });
}

// ---- обновления модов из каталога ----

/** Сравнить версии «1.2.10» и «1.2.9»; буквы и «v» в начале не мешают. */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Версия плагина uMod из строки [Info("Название", "Автор", "1.2.3")]. */
function umodInfo(text) {
  const m = /\[Info\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]+)"/.exec(text);
  return m ? { title: m[1], author: m[2], version: m[3] } : null;
}

/** Какие моды из каталога можно обновить. Возвращает [{ id, title, current, latest }]. */
async function checkUpdates({ dir, game, fetchFn = fetch }) {
  const c = (game.mods || {}).catalog;
  if (!c) throw new Error('У этой игры нет каталога модов');
  const out = [];
  if (c.type === 'umod') {
    const base = path.join(dir, c.folder);
    let names = [];
    try {
      names = fs.readdirSync(base).filter((n) => /^[\w.-]+\.cs$/.test(n));
    } catch {
      return [];
    }
    for (const file of names) {
      const info = umodInfo(fs.readFileSync(path.join(base, file), 'utf8'));
      if (!info) continue;
      const j = await getJson(`https://umod.org/plugins/search.json?query=${encodeURIComponent(info.title)}&page=1&categories%5B%5D=${c.game}`, fetchFn);
      const hit = (j.data || []).find((p) => path.basename(p.download_url || '') === file);
      const latest = hit && String(hit.latest_release_version || hit.latest_release_version_formatted || '').replace(/^v/i, '');
      if (latest && cmpVersion(latest, info.version) > 0) out.push({ id: file, title: info.title, current: info.version, latest });
    }
    return out;
  }
  // Thunderstore: моды лежат в BepInEx/plugins/<Автор-Мод>/manifest.json
  const base = path.join(dir, c.root, 'BepInEx', 'plugins');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[\w.]+-[\w.]+$/.test(e.name));
  } catch {
    return [];
  }
  for (const d of dirs) {
    const current = readVersion(path.join(base, d.name));
    if (!current) continue;
    const i = d.name.indexOf('-');
    const namespace = d.name.slice(0, i);
    const name = d.name.slice(i + 1);
    let pkg;
    try {
      pkg = await getJson(`https://thunderstore.io/api/experimental/package/${namespace}/${name}/`, fetchFn);
    } catch {
      continue; // мод удалили из каталога — пропускаем
    }
    const latest = (pkg.latest || {}).version_number;
    if (latest && cmpVersion(latest, current) > 0) out.push({ id: `${namespace}/${name}`, title: name.replace(/_/g, ' '), current, latest });
  }
  return out;
}

/** Обновить один мод из каталога (поставить его последнюю версию поверх). */
async function updateFromCatalog({ dir, game, itemId, fetchFn = fetch, onProgress = () => {} }) {
  const c = (game.mods || {}).catalog;
  if (!c) throw new Error('У этой игры нет каталога модов');
  if (c.type === 'umod') return installFromCatalog({ dir, game, itemId, fetchFn, onProgress });
  const [namespace, name] = String(itemId).split('/');
  return installThunderstore({ dir, catalog: c, namespace, name: name || '', fetchFn, onProgress, force: true });
}

module.exports = {
  frameworks, installFramework, removeFramework, fwInstalled, getFw,
  folders, removeItem, toggleItem, addFile,
  search, installFromCatalog, planThunderstore, safeName,
  checkUpdates, updateFromCatalog, cmpVersion, umodInfo,
};
