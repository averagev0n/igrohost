// Поиск мода, из-за которого сервер падает: половину модов убираем, запускаем сервер,
// смотрим, упал ли, и сужаем круг. Здесь — план поиска и перекладывание файлов;
// сами запуски делает app.js. Мир перед поиском сохраняется копией и в конце возвращается.
const fs = require('fs');
const path = require('path');

const OFF_DIR = '.igrohost-modtest'; // сюда на время проверки уезжают выключенные моды
const STATE_FILE = 'modtest.json'; // что вернуть, если панель закрыли посреди поиска

/**
 * Все моды сервера из папок игры: [{ key, folder, name, deps }].
 * key — «папка/имя», deps — ключи модов, без которых этот не запустится (по manifest.json Thunderstore).
 */
function collect(dir, game) {
  const out = [];
  for (const f of (game.mods || {}).folders || []) {
    const base = path.join(dir, f.path);
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (f.keep && f.keep.test(e.name)) continue;
      if (e.isDirectory() ? !f.dirs : !(f.exts || []).includes(path.extname(e.name).toLowerCase())) continue;
      let deps = [];
      try {
        const m = JSON.parse(fs.readFileSync(path.join(base, e.name, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
        deps = (m.dependencies || []).map((d) => String(d).replace(/-\d+\.\d+\.\d+$/, ''));
      } catch {
        /* не мод Thunderstore — зависимостей не знаем */
      }
      out.push({ key: `${f.id}/${e.name}`, folder: f.id, name: e.name, deps });
    }
  }
  // Зависимости Thunderstore записаны как «Автор-Мод»: так же называются папки модов.
  const byName = new Map(out.map((m) => [m.name, m.key]));
  for (const m of out) m.deps = m.deps.map((d) => byName.get(d)).filter(Boolean);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Добавить к набору модов всё, без чего они не запустятся. */
function closure(keys, mods) {
  const byKey = new Map(mods.map((m) => [m.key, m]));
  const out = new Set(keys);
  const queue = [...keys];
  while (queue.length) {
    const m = byKey.get(queue.pop());
    if (!m) continue;
    for (const d of m.deps) {
      if (!out.has(d)) {
        out.add(d);
        queue.push(d);
      }
    }
  }
  return [...out];
}

/**
 * План поиска. next() — какие моды включить ({ enable } или { done, … });
 * report(crashed) — чем закончился запуск. Первый запуск — со всеми модами:
 * если сервер не падает, искать нечего.
 */
function createSearch(mods) {
  const all = mods.map((m) => m.key);
  let suspects = all.slice();
  let cleared = [];
  let phase = 'full';
  let half = [];
  let runs = 0;
  let result = null;
  return {
    total: all.length,
    get runs() {
      return runs;
    },
    get suspects() {
      return suspects.slice();
    },
    left() {
      if (result) return 0;
      return Math.ceil(Math.log2(Math.max(1, suspects.length))) + (phase === 'full' ? 1 : 0);
    },
    next() {
      if (result) return { done: true, ...result };
      if (phase === 'full') return { enable: all.slice() };
      half = suspects.slice(0, Math.ceil(suspects.length / 2));
      return { enable: closure([...cleared, ...half], mods) };
    },
    report(crashed) {
      runs++;
      if (phase === 'full') {
        phase = 'split';
        if (!crashed) result = { noRepro: true };
        else if (suspects.length === 1) result = { culprit: suspects[0], needs: [] };
        return;
      }
      if (crashed) suspects = half;
      else {
        cleared = [...new Set([...cleared, ...closure(half, mods)])];
        suspects = suspects.filter((k) => !half.includes(k));
      }
      if (suspects.length === 1) result = { culprit: suspects[0], needs: closure([suspects[0]], mods).filter((k) => k !== suspects[0]) };
      else if (!suspects.length) result = { combo: true }; // поодиночке всё запускается — дело в сочетании модов
    },
  };
}

const folderPath = (dir, game, id) => path.join(dir, ((game.mods || {}).folders || []).find((f) => f.id === id).path);
const offPath = (dir, key) => path.join(dir, OFF_DIR, ...key.split('/'));

/** Оставить включёнными только enable: остальные моды уезжают в служебную папку. */
function apply(dir, game, mods, enable) {
  const on = new Set(enable);
  for (const m of mods) {
    const live = path.join(folderPath(dir, game, m.folder), m.name);
    const off = offPath(dir, m.key);
    if (on.has(m.key) && fs.existsSync(off) && !fs.existsSync(live)) fs.renameSync(off, live);
    if (!on.has(m.key) && fs.existsSync(live)) {
      fs.mkdirSync(path.dirname(off), { recursive: true });
      fs.renameSync(live, off);
    }
  }
}

/** Вернуть все моды на место (после поиска или если панель закрыли посреди него). */
function restoreAll(dir, game) {
  const root = path.join(dir, OFF_DIR);
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const f of (game.mods || {}).folders || []) {
    const src = path.join(root, f.id);
    let names = [];
    try {
      names = fs.readdirSync(src);
    } catch {
      continue;
    }
    for (const name of names) {
      const live = path.join(dir, f.path, name);
      if (fs.existsSync(live)) continue;
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.renameSync(path.join(src, name), live);
      n++;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  return n;
}

const stateFile = (dir) => path.join(dir, STATE_FILE);
const saveState = (dir, s) => fs.writeFileSync(stateFile(dir), JSON.stringify(s));
const readState = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
  } catch {
    return null;
  }
};
const clearState = (dir) => fs.rmSync(stateFile(dir), { force: true });

module.exports = { collect, closure, createSearch, apply, restoreAll, saveState, readState, clearState, OFF_DIR };
