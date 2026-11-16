// Список игр и общие операции над их настройками.
const crypto = require('crypto');
const { cleanText } = require('../util');

const GAMES = [
  require('./terraria'),
  require('./valheim'),
  require('./rust'),
  require('./cs2'),
  require('./palworld'),
  require('./zomboid'),
  require('./sdtd'),
  require('./enshrouded'),
];
const byId = new Map(GAMES.map((g) => [g.id, g]));

function getGame(id) {
  const g = byId.get(id);
  if (!g) throw new Error('Неизвестная игра');
  return g;
}

const randomPassword = () => crypto.randomBytes(9).toString('base64url');

/** Настройки по умолчанию; секреты и обязательные пароли создаются случайными. */
function defaults(game) {
  const s = {};
  for (const f of game.fields) s[f.key] = f.generate ? randomPassword() : f.def;
  return s;
}

/** Привести настройки из формы к типам и проверить по описанию полей. */
function cleanSettings(game, input, base = defaults(game)) {
  const s = {};
  for (const f of game.fields) {
    const raw = input && input[f.key] !== undefined ? input[f.key] : base[f.key];
    if (f.type === 'bool') {
      s[f.key] = raw === true || raw === 'true' || raw === 1;
    } else if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || (!f.step && !Number.isInteger(n))) throw new Error(`«${f.label}» — нужно число`);
      if (n < f.min || n > f.max) throw new Error(`«${f.label}» — от ${f.min} до ${f.max}`);
      s[f.key] = n;
    } else if (f.type === 'select') {
      const v = String(raw ?? '');
      if (!f.options.some((o) => o[0] === v)) throw new Error(`«${f.label}» — выберите значение из списка`);
      s[f.key] = v;
    } else {
      let v = cleanText(raw, f.max || 200);
      if (f.type === 'secret' && f.generate && !v) v = randomPassword();
      if (f.required && !v) throw new Error(`Заполните поле «${f.label}»`);
      if (v && f.min && v.length < f.min) throw new Error(`«${f.label}» — не короче ${f.min} символов`);
      if (v && f.pattern && !new RegExp(f.pattern).test(v)) throw new Error(`«${f.label}» — недопустимые символы`);
      s[f.key] = v;
    }
  }
  if (game.validate) game.validate(s);
  return s;
}

/** Все порты, которые займёт сервер с такими настройками (для проверки пересечений). */
function portsOf(game, s) {
  const f = game.fields.find((x) => x.port);
  const span = (f && f.span) || 1;
  const set = new Set(game.ports(s).map((p) => p.port));
  for (let i = 0; i < span; i++) set.add(s[f.key] + i);
  return [...set];
}

/** Сдвинуть порт, пока он пересекается с занятыми. */
function freePorts(game, s, used) {
  const f = game.fields.find((x) => x.port);
  const taken = new Set(used);
  const next = { ...s };
  for (let i = 0; i < 200 && portsOf(game, next).some((p) => taken.has(p)); i++) next[f.key] += 10;
  return next;
}

/** То, что нужно интерфейсу: без функций и регулярных выражений. */
function publicGame(g) {
  return {
    id: g.id,
    title: g.title,
    about: g.about,
    size: g.size,
    badge: g.badge,
    color: g.color,
    console: g.console,
    hint: g.hint,
    fields: g.fields,
    defaults: defaults(g),
    hasCatalog: !!(g.mods && g.mods.catalog),
    modsNote: (g.mods && g.mods.note) || '',
  };
}

module.exports = { GAMES, getGame, defaults, cleanSettings, portsOf, freePorts, publicGame, randomPassword };
