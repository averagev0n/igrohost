// Интерфейс панели. Данные приходят вызовами /api/call и событиями /api/events.
'use strict';

// ---- связь с ядром ----

const api = {
  async call(method, arg) {
    const res = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, arg }) });
    if (res.status === 401) throw new Error('Ключ доступа устарел — откройте панель заново из окна программы');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j.data;
  },
  async upload(id, folder, file) {
    const q = new URLSearchParams({ id, folder, name: file.name });
    const res = await fetch('/api/upload?' + q, { method: 'POST', body: file });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j.data;
  },
};

// ---- маленькие помощники ----

/** h('div', { class: 'x', onclick: fn }, 'текст', узел…) — собрать элемент без innerHTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

const STATE = { stopped: 'Выключен', starting: 'Запускается', running: 'Работает', stopping: 'Останавливается', installing: 'Установка' };

function fmtSize(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1).replace('.', ',') + ' ГБ';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1).replace('.', ',') + ' МБ';
  return Math.max(1, Math.round(n / 1024)) + ' КБ';
}
const fmtDate = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const fmtNum = (n) => Number(n).toLocaleString('ru-RU');
function fmtUptime(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'меньше минуты';
  const hr = Math.floor(min / 60);
  return hr ? `${hr} ч ${min % 60} мин` : `${min} мин`;
}

function toast(text, error) {
  const el = h('div', { class: 'toast' + (error ? ' error' : '') }, text);
  $('toasts').append(el);
  setTimeout(() => el.remove(), error ? 9000 : 5000);
}

/** Выполнить действие; ошибку показать уведомлением. Кнопка на время блокируется. */
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

function confirmBox(title, text, yes) {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yes;
    d.returnValue = 'no';
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}

// ---- состояние ----

const S = {
  info: null,
  list: [],
  sel: null, // id сервера, 'new' или 'tg'
  tab: 'console',
  wizardGame: null,
  logs: new Map(), // id → [{ text, kind }]
  tg: null,
};
const gameById = (id) => S.info.games.find((g) => g.id === id);
const current = () => S.list.find((i) => i.id === S.sel);

function badge(game, state, big) {
  return h('span', { class: 'badge' + (big ? ' big' : ''), style: null, 'data-color': game.color }, game.badge, state ? h('i', { class: 'dot ' + state }) : null);
}
/** Цвет значка задаётся через CSSOM: политика безопасности страницы запрещает атрибут style. */
function paintBadges(root) {
  for (const b of root.querySelectorAll('[data-color]')) b.style.backgroundColor = b.dataset.color;
}

// ---- полка с серверами ----

const BRAND_COLOR = '#c9652b';

/** Подпись на картридже: кто играет или что происходит с сервером. */
function lampText(i) {
  if (i.state === 'running') return i.players.length ? `${i.players.length} в игре` : 'Работает';
  if (i.state === 'installing') return i.job && i.job.pct ? `Установка ${i.job.pct}%` : 'Установка';
  return i.installed ? STATE[i.state] : 'Не установлен';
}

function renderSide() {
  const list = $('srv-list');
  list.replaceChildren(
    ...S.list.map((i) => {
      const g = gameById(i.game);
      const cls = ['cart', S.sel === i.id ? 'sel' : '', i.state === 'running' ? 'on' : i.state === 'stopped' ? 'off' : 'busy'].join(' ');
      return h(
        'button',
        { type: 'button', class: cls, 'data-color': g.color, 'aria-current': String(S.sel === i.id), onclick: () => select(i.id) },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, g.badge),
        h('span', { class: 'lamp' }, h('i'), lampText(i)),
        h('span', { class: 'cart-game' }, i.gameTitle),
        h('span', { class: 'cart-name' }, i.name)
      );
    })
  );
  paintBadges(list);
  $('srv-new').setAttribute('aria-current', String(S.sel === 'new'));
  $('tg-open').setAttribute('aria-current', String(S.sel === 'tg'));
  $('tg-sub').textContent = S.tg && S.tg.linked ? 'Telegram @' + S.tg.bot : S.tg && S.tg.connected ? 'ждёт привязки чата' : 'Telegram, Discord, телефон';

  // Страница окрашивается в цвет игры выбранного сервера.
  const cur = current();
  document.documentElement.style.setProperty('--field', cur ? gameById(cur.game).color : BRAND_COLOR);

  const running = S.list.filter((i) => i.state === 'running');
  const players = running.reduce((n, i) => n + i.players.length, 0);
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
  $('sum').textContent = !S.list.length
    ? ''
    : !running.length
      ? 'Все серверы выключены'
      : players
        ? `Сейчас ${plural(players, 'играет', 'играют', 'играют')} ${players} ${plural(players, 'человек', 'человека', 'человек')} на ${running.length} ${plural(running.length, 'сервере', 'серверах', 'серверах')}`
        : `${plural(running.length, 'Работает', 'Работают', 'Работают')} ${running.length} ${plural(running.length, 'сервер', 'сервера', 'серверов')}, игроков пока нет`;
}

function select(sel, tab) {
  S.sel = sel;
  if (tab) S.tab = tab;
  if (sel === 'new') S.wizardGame = null;
  renderSide();
  renderMain();
}

// ---- формы настроек ----

function fieldInput(f, value) {
  if (f.type === 'bool') return h('input', { type: 'checkbox', name: f.key, checked: !!value });
  if (f.type === 'select') return h('select', { name: f.key }, f.options.map(([v, label]) => h('option', { value: v, selected: v === String(value) }, label)));
  const el = h('input', { type: f.type === 'number' ? 'number' : 'text', name: f.key, value: value === undefined ? '' : String(value), autocomplete: 'off', spellcheck: 'false' });
  if (f.type === 'number') {
    el.min = f.min;
    el.max = f.max;
    el.step = f.step || 1;
  } else if (f.max) el.maxLength = f.max;
  if (f.list) {
    el.setAttribute('list', 'dl-' + f.key);
    return [el, h('datalist', { id: 'dl-' + f.key }, f.list.map((v) => h('option', { value: v })))];
  }
  return el;
}

function fieldsForm(game, values) {
  return game.fields.map((f) => {
    if (f.type === 'bool') return h('label', { class: 'check field wide' }, fieldInput(f, values[f.key]), h('span', null, f.label));
    return h('label', { class: 'field' + (f.key === 'gslt' || f.key === 'description' || f.key === 'motd' ? ' wide' : '') }, h('span', null, f.label), fieldInput(f, values[f.key]), f.hint ? h('span', { class: 'hint' }, f.hint) : null);
  });
}

function readFields(game, form) {
  const out = {};
  for (const f of game.fields) {
    const el = form.elements[f.key];
    out[f.key] = f.type === 'bool' ? el.checked : f.type === 'number' ? Number(el.value) : el.value;
  }
  return out;
}

// ---- мастер нового сервера ----

function renderWizard() {
  if (!S.wizardGame) {
    return h(
      'div',
      { class: 'page' },
      h('h1', null, 'Какой сервер нужен?'),
      h('p', { class: 'lead' }, 'Выберите игру. Панель сама скачает сервер, настроит его и будет следить, чтобы мир не пропал.'),
      h(
        'div',
        { class: 'choices' },
        S.info.games.map((g) =>
          h(
            'button',
            { type: 'button', class: 'choice', onclick: () => ((S.wizardGame = g.id), renderMain()) },
            h('span', { class: 'choice-top' }, badge(g, null, true), h('span', { class: 'choice-title' }, g.title)),
            h('span', { class: 'choice-text' }, g.about),
            h('span', { class: 'meta' }, 'Займёт на диске ' + g.size)
          )
        )
      ),
      importCard()
    );
  }
  const g = gameById(S.wizardGame);
  const form = h(
    'form',
    {
      class: 'card stack',
      onsubmit: (e) => {
        e.preventDefault();
        act(form.querySelector('button[type=submit]'), async () => {
          const inst = await api.call('inst:create', { game: g.id, name: form.elements.__name.value, settings: readFields(g, form) });
          S.list = await api.call('inst:list');
          select(inst.id, 'console');
        });
      },
    },
    h('div', { class: 'form' }, h('label', { class: 'field wide' }, h('span', null, 'Название в панели'), h('input', { type: 'text', name: '__name', value: g.title, maxlength: 60 })), fieldsForm(g, g.defaults)),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Создать сервер'), h('button', { type: 'button', class: 'btn', onclick: () => ((S.wizardGame = null), renderMain()) }, 'Назад'), h('span', { class: 'meta' }, 'Скачивание начнётся после вашего подтверждения на следующем шаге.'))
  );
  return h('div', { class: 'page' }, h('div', { class: 'wz-head' }, badge(g, null, true), h('div', { class: 'head-text' }, h('h1', null, 'Новый сервер ' + g.title), h('p', { class: 'meta' }, 'Все настройки можно поменять позже.'))), form);
}

// ---- страница сервера ----

function headNode(i) {
  const g = gameById(i.game);
  const st = [h('b', { class: 'st-' + i.state }, i.installed || i.state === 'installing' ? STATE[i.state] : 'Не установлен')];
  if (i.state === 'running' && i.startedAt) st.push(' ' + fmtUptime(Date.now() - i.startedAt));
  if (i.asleep) st.push(' — уснул, пока никого не было');
  st.push(' · ' + g.title);
  return h(
    'div',
    { id: 'head', class: 'head' },
    h('h1', null, i.name),
    h('p', { class: 'st' }, st),
    i.players.length ? h('div', { class: 'who' }, i.players.map((p) => h('span', null, h('i', { 'aria-hidden': 'true' }, p.slice(0, 1).toUpperCase()), p))) : null,
    i.busy ? h('p', { class: 'meta' }, i.busy + '…') : null
  );
}

function statusNode(i) {
  const g = gameById(i.game);
  const box = h('div', { id: 'status', class: 'status' });
  const btn = (text, cls, method, disabled) => h('button', { type: 'button', class: 'btn big ' + cls, disabled, onclick: (e) => act(e.currentTarget, () => api.call(method, { id: i.id })) }, text);
  if (i.state === 'installing') {
    const job = i.job || { pct: 0, text: 'Подготовка' };
    box.append(
      h('div', { class: 'job' }, h('b', { id: 'job-text' }, `${job.text}${job.pct ? ` — ${job.pct}%` : ''}`), h('div', { class: 'bar-line' }, h('i', { id: 'job-bar', 'data-pct': job.pct }))),
      h('div', { class: 'acts' }, btn('Отменить установку', '', 'inst:cancelInstall'))
    );
  } else if (!i.installed) {
    box.append(
      h('div', { class: 'addr' }, h('small', null, 'Сервер ещё не установлен'), h('p', null, `Скачается ${g.size}${g.id === 'terraria' ? ' с сайта terraria.org' : ' через SteamCMD — официальную программу Valve'}.`)),
      h('div', { class: 'acts' }, btn('Установить', 'primary', 'inst:install'))
    );
  } else {
    const address = `${S.info.addresses[0] || '127.0.0.1'}:${i.ports[0].port}`;
    const open = i.ports.filter((p) => !/наружу/.test(p.what || '')).map((p) => `${p.port} ${p.proto}`).join(', ');
    box.append(
      h(
        'div',
        { class: 'addr' },
        i.joinCode
          ? [h('small', null, i.joinCodeLabel), h('button', { type: 'button', class: 'addr-copy', title: 'Скопировать код', onclick: () => navigator.clipboard.writeText(i.joinCode).then(() => toast('Код скопирован')) }, i.joinCode), h('p', null, 'По коду друзья заходят из любой сети, порты не нужны.'), h('small', { class: 'gap' }, 'Или по адресу в вашей сети')]
          : h('small', null, 'Адрес для друзей в вашей сети'),
        h('button', { type: 'button', class: 'addr-copy', title: 'Скопировать адрес', onclick: () => navigator.clipboard.writeText(address).then(() => toast('Адрес скопирован')) }, address),
        i.net.tunnel
          ? h('p', null, 'Через интернет: ', h('button', { type: 'button', class: 'link-btn mono', onclick: () => navigator.clipboard.writeText(i.net.tunnel).then(() => toast('Адрес туннеля скопирован')) }, i.net.tunnel))
          : h('p', null, i.net.upnp ? 'Порты на роутере панель откроет сама. ' : `Для игры через интернет нужны порты ${open}. `, h('button', { type: 'button', class: 'link-btn', onclick: () => select(i.id, 'net') }, 'Настроить')),
        i.update && i.update.available ? h('p', { class: 'upd' }, 'Вышла новая версия сервера игры. ', h('button', { type: 'button', class: 'link-btn', onclick: () => select(i.id, 'settings') }, 'Обновить')) : null,
        h('button', { type: 'button', class: 'link-btn invite-btn', onclick: (e) => act(e.currentTarget, async () => {
          const text = await api.call('invite:text', { id: i.id });
          await navigator.clipboard.writeText(text);
          toast('Приглашение скопировано — вставьте его в чат друзьям');
        }) }, 'Скопировать приглашение для друзей')
      ),
      h(
        'div',
        { class: 'acts' },
        i.state === 'stopped' ? btn('Запустить', 'primary', 'inst:start') : btn('Остановить', 'primary', 'inst:stop', i.state === 'stopping'),
        i.state !== 'stopped' ? btn('Перезапустить', '', 'inst:restart', i.state !== 'running') : null
      )
    );
  }
  return box;
}

function setBars(root) {
  for (const b of root.querySelectorAll('.bar-line > i[data-pct]')) b.style.width = b.dataset.pct + '%';
}

const TABS = [
  ['console', 'Консоль'],
  ['players', 'Игроки'],
  ['net', 'Интернет'],
  ['settings', 'Настройки'],
  ['files', 'Файлы'],
  ['mods', 'Моды'],
  ['backups', 'Копии'],
];

/** Нагрузка на компьютер: процессор и память сервера. */
function statsNode(i) {
  const s = i.stats;
  if (!s || i.state === 'stopped') return h('div', { id: 'stats', hidden: true });
  const gb = (mb) => (mb / 1024).toFixed(1).replace('.', ',');
  const mem = (mb) => (mb < 1024 ? `${mb} МБ` : `${gb(mb)} ГБ`);
  const low = s.sysFreeMb / s.sysTotalMb < 0.1;
  return h(
    'div',
    { id: 'stats', class: 'stats' + (low ? ' low' : '') },
    h('span', null, h('small', null, 'Процессор'), h('b', null, `${String(s.cpu).replace('.', ',')}%`)),
    h('span', null, h('small', null, 'Память сервера'), h('b', null, mem(s.memMb))),
    h('span', null, h('small', null, 'Свободно на ПК'), h('b', null, `${gb(s.sysFreeMb)} из ${gb(s.sysTotalMb)} ГБ`)),
    low ? h('p', { class: 'stats-warn' }, 'Памяти почти не осталось — закройте лишние программы, иначе сервер может упасть.') : null
  );
}

// ---- график нагрузки ----
// Два маленьких графика с общей вертикальной линией при наведении: процессор (0–100 %) и память.
// Две разные величины — два графика, а не одна картинка с двумя шкалами.

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const timeHM = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const gbText = (mb) => (mb < 1024 ? `${mb} МБ` : `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`);

function sparkPath(points, w, h, max) {
  if (!points.length) return { line: '', area: '' };
  const n = points.length;
  const x = (k) => (n === 1 ? w : (k / (n - 1)) * w);
  const y = (v) => h - 2 - (Math.min(v, max) / max) * (h - 4);
  const line = points.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z` };
}

function historyNode(i, data) {
  const box = h('div', { id: 'hist', class: 'hist' });
  if (!data || data.length < 2) {
    box.hidden = true;
    return box;
  }
  const W = 300;
  const H = 46;
  const memMax = Math.max(1024, ...data.map((p) => p.mem)) * 1.1;
  const readout = h('p', { class: 'hist-read', 'aria-live': 'polite' });
  const last = data[data.length - 1];
  const idle = () => (readout.textContent = `За ${Math.round((data[data.length - 1].t - data[0].t) / 3600000) || 1} ч · сейчас ${String(last.cpu).replace('.', ',')}% и ${gbText(last.mem)}`);
  idle();
  const charts = [
    { title: 'Процессор', values: data.map((p) => p.cpu), max: 100 },
    { title: 'Память', values: data.map((p) => p.mem), max: memMax },
  ].map((c) => {
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'spark', role: 'img', 'aria-label': `${c.title} за последние часы` });
    const p = sparkPath(c.values, W, H, c.max);
    s.append(svg('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, class: 'spark-base' }), svg('path', { d: p.area, class: 'spark-area' }), svg('path', { d: p.line, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }));
    const cross = svg('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'spark-cross', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
    s.append(cross);
    return { ...c, el: s, cross };
  });
  // Наводим на любой из двух графиков — линия и подпись общие для обоих.
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.max(0, Math.min(data.length - 1, Math.round(((e.clientX - r.left) / r.width) * (data.length - 1))));
    const x = data.length === 1 ? W : (k / (data.length - 1)) * W;
    for (const c of charts) {
      c.cross.setAttribute('x1', x);
      c.cross.setAttribute('x2', x);
      c.cross.setAttribute('visibility', 'visible');
    }
    readout.textContent = `${timeHM(data[k].t)} · процессор ${String(data[k].cpu).replace('.', ',')}% · память ${gbText(data[k].mem)}`;
  };
  const onLeave = () => {
    for (const c of charts) c.cross.setAttribute('visibility', 'hidden');
    idle();
  };
  for (const c of charts) {
    c.el.addEventListener('pointermove', onMove);
    c.el.addEventListener('pointerleave', onLeave);
    box.append(h('div', { class: 'spark-row' }, h('small', null, c.title), c.el));
  }
  box.append(readout);
  return box;
}

function loadHistory(i) {
  if (!$('hist')) return;
  api.call('stats:history', { id: i.id }).then((data) => {
    if (S.sel === i.id && $('hist')) $('hist').replaceWith(historyNode(i, data));
  }, () => {});
}

/** Почему сервер упал в последний раз — пока его не запустили снова. */
function crashNode(i) {
  const c = i.lastCrash;
  if (!c || i.state !== 'stopped') return h('div', { id: 'crash', hidden: true });
  return h(
    'div',
    { id: 'crash', class: 'crash' },
    h('b', null, c.title ? `Сервер упал: ${c.title.toLowerCase()}` : `Сервер неожиданно остановился${c.code ? ` (код ${c.code})` : ''}`),
    h('p', null, c.advice || 'Посмотрите последние строки во вкладке «Консоль» — обычно причина там.'),
    c.line ? h('code', null, c.line) : null
  );
}

function renderServer(i) {
  const body = h('div', { id: 'tab-body', class: 'tab-body stack' });
  ({ console: tabConsole, players: tabPlayers, net: tabNet, settings: tabSettings, files: tabFiles, mods: tabMods, backups: tabBackups })[S.tab](i, body);
  return [
    h('aside', { class: 'left' }, headNode(i), crashNode(i), statsNode(i), historyNode(i, null), statusNode(i)),
    h(
      'section',
      { class: 'right' + (S.tab === 'console' ? ' fill' : '') },
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        TABS.map(([id, label]) => h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => select(i.id, id) }, label))
      ),
      body
    ),
  ];
}

// консоль

function lineNode(l) {
  return h('div', { class: l.kind }, l.text);
}

function tabConsole(i, body) {
  const g = gameById(i.game);
  const log = h('div', { class: 'log', id: 'log', tabindex: '0', 'aria-label': 'Журнал сервера' });
  const fill = (lines) => {
    if (!lines.length) log.replaceChildren(h('div', { class: 'log-empty' }, i.installed ? 'Сервер выключен. Запустите его — здесь появится журнал.' : 'Журнал появится после установки и запуска.'));
    else log.replaceChildren(...lines.map(lineNode));
    log.scrollTop = log.scrollHeight;
  };
  fill(S.logs.get(i.id) || []);
  const q = h('input', { type: 'search', placeholder: 'Найти в журнале', 'aria-label': 'Найти в журнале', class: 'log-q' });
  const onlyErr = h('input', { type: 'checkbox' });
  const applyFilter = () => {
    const needle = q.value.trim().toLowerCase();
    const errs = onlyErr.checked;
    log.classList.toggle('filtered', !!(needle || errs));
    for (const row of log.children) {
      const show = (!errs || row.classList.contains('error') || /error|exception|fail|ошибк/i.test(row.textContent)) && (!needle || row.textContent.toLowerCase().includes(needle));
      row.hidden = !show;
    }
  };
  S.logFilter = applyFilter;
  q.addEventListener('input', applyFilter);
  onlyErr.addEventListener('change', applyFilter);
  body.append(
    h('div', { class: 'log-tools' }, q, h('label', { class: 'check' }, onlyErr, h('span', null, 'Только ошибки')), h('a', { class: 'btn small', href: `/api/log?id=${encodeURIComponent(i.id)}`, download: 'server-log.txt' }, 'Скачать журнал')),
    log
  );
  if (!S.logs.has(i.id)) {
    api.call('inst:lines', { id: i.id }).then((lines) => {
      S.logs.set(i.id, lines);
      if (S.sel === i.id && S.tab === 'console' && log.isConnected) fill(lines);
    }, () => {});
  }
  if (g.console !== 'none') {
    const input = h('input', { type: 'text', id: 'cmd', placeholder: 'Команда серверу', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Команда серверу' });
    const form = h(
      'form',
      {
        class: 'cmd',
        onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          act(null, () => api.call('inst:command', { id: i.id, text }));
        },
      },
      input,
      h('button', { type: 'submit', class: 'btn' }, 'Отправить')
    );
    body.append(form);
  }
  if (g.hint) body.append(h('p', { class: 'meta' }, g.hint));
}

function appendLog(id, line, replace) {
  const lines = S.logs.get(id) || [];
  if (replace && lines.length >= replace) {
    // Строка хода заменяет прежнюю такую же, а не добавляется.
    lines[lines.length - replace] = line;
    const box = $('log');
    if (S.sel === id && S.tab === 'console' && box && box.childNodes.length >= replace && !box.firstChild.classList.contains('log-empty')) {
      box.childNodes[box.childNodes.length - replace].replaceWith(lineNode(line));
    }
    return;
  }
  lines.push(line);
  if (lines.length > 2000) lines.splice(0, lines.length - 2000);
  S.logs.set(id, lines);
  const log = $('log');
  if (S.sel !== id || S.tab !== 'console' || !log) return;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (log.firstChild && log.firstChild.classList.contains('log-empty')) log.replaceChildren();
  const node = lineNode(line);
  log.append(node);
  if (log.classList.contains('filtered') && S.logFilter) S.logFilter();
  while (log.childNodes.length > 2000) log.firstChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
}

// игроки

const PLAYER_ACTIONS = {
  kick: ['Выгнать', (n) => `Выгнать ${n} с сервера?`, 'Игрок сможет зайти снова.'],
  ban: ['Заблокировать', (n) => `Заблокировать ${n}?`, 'Игрок больше не сможет зайти на этот сервер.'],
  admin: ['Сделать админом', (n) => `Сделать ${n} администратором?`, 'Администратор может выгонять игроков и менять мир командами.'],
};

function tabPlayers(i, body) {
  const running = i.state === 'running';
  if (i.canSay) {
    const input = h('input', { type: 'text', placeholder: 'Сообщение всем на сервере', maxlength: 200, autocomplete: 'off', 'aria-label': 'Сообщение всем на сервере', disabled: !running });
    body.append(
      h(
        'form',
        {
          class: 'cmd',
          onsubmit: (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            act(e.currentTarget.querySelector('button'), async () => {
              await api.call('players:say', { id: i.id, text });
              input.value = '';
              toast('Сообщение отправлено');
            });
          },
        },
        input,
        h('button', { type: 'submit', class: 'btn', disabled: !running }, 'Отправить')
      )
    );
  }
  const list = h('div', { class: 'list' });
  if (!running) list.append(h('p', { class: 'empty' }, 'Сервер выключен — игроков нет.'));
  else if (!i.players.length) list.append(h('p', { class: 'empty' }, 'Сейчас на сервере никого нет.'));
  for (const name of i.players) {
    list.append(
      h(
        'div',
        { class: 'item' },
        h('span', { class: 'ava', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()),
        h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, name)),
        i.playerActions.map((a) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn small' + (a === 'ban' ? ' danger' : ''),
              onclick: async (e) => {
                const btn = e.currentTarget;
                const [label, title, text] = PLAYER_ACTIONS[a];
                if (!(await confirmBox(title(name), text, label))) return;
                act(btn, async () => {
                  const reply = await api.call('players:action', { id: i.id, name, action: a });
                  toast(reply ? String(reply).split('\n')[0].slice(0, 160) : 'Команда отправлена');
                });
              },
            },
            PLAYER_ACTIONS[a][0]
          )
        )
      )
    );
  }
  body.append(h('div', { class: 'card' }, h('h2', null, running ? `На сервере: ${i.players.length}` : 'Игроки'), list));
  if (i.playersNote) body.append(h('p', { class: 'meta' }, i.playersNote));
  if (i.hasLists) body.append(listsNode(i));
}

function listsNode(i) {
  const box = h('div', { class: 'stack' });
  const draw = (lists, restart) => {
    box.replaceChildren(
      ...lists.map((l) => {
        const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Steam ID, например 76561198000000000', maxlength: 17, 'aria-label': `Добавить в список «${l.title}»` });
        return h(
          'div',
          { class: 'card stack' },
          h('h2', null, l.title),
          l.note ? h('p', { class: 'meta' }, l.note) : null,
          h(
            'div',
            { class: 'list' },
            l.entries.length
              ? l.entries.map((id) => h('div', { class: 'item' }, h('div', { class: 'item-text mono' }, id), h('button', { type: 'button', class: 'btn small', onclick: (e) => act(e.currentTarget, async () => {
                  const r = await api.call('lists:edit', { id: i.id, list: l.id, value: id, add: false });
                  draw(r.lists, r.restart);
                }) }, 'Убрать')))
              : h('p', { class: 'empty' }, 'Список пуст.')
          ),
          h('form', { class: 'cmd', onsubmit: (e) => {
            e.preventDefault();
            act(e.currentTarget.querySelector('button'), async () => {
              const r = await api.call('lists:edit', { id: i.id, list: l.id, value: input.value, add: true });
              draw(r.lists, r.restart);
            });
          } }, input, h('button', { type: 'submit', class: 'btn' }, 'Добавить'))
        );
      }),
      h('p', { class: 'meta' }, restart ? 'Изменения вступят в силу после перезапуска сервера.' : 'Steam ID видно в профиле Steam (адрес профиля с цифрами) или на сайте steamid.io.')
    );
  };
  api.call('lists:get', { id: i.id }).then((lists) => draw(lists, false), (e) => box.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return box;
}

// доступ из интернета

function tabNet(i, body) {
  const n = i.net;
  const ns = i.netState && i.netState.upnp;
  const save = (patch, btn) => act(btn, async () => {
    await api.call('net:set', { id: i.id, ...patch });
  });
  const ports = i.ports.filter((p) => !/наружу/.test(p.what || ''));

  // UPnP
  body.append(
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Открывать порты на роутере'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.upnp, onchange: (e) => save({ upnp: e.currentTarget.checked }) }), h('span', null, `Пока сервер работает, панель сама откроет на роутере порты ${ports.map((p) => `${p.port} ${p.proto}`).join(', ')} (UPnP) и закроет их после остановки.`)),
      ns ? h('p', { class: ns.ok ? 'ok-text' : 'err-text' }, ns.ok ? 'Порты открыты.' : `Не получилось: ${ns.error}`) : null,
      h('p', { class: 'meta' }, 'Если роутер не поддерживает UPnP, откройте эти порты в его настройках вручную (раздел «Переадресация портов» или «Port forwarding») на адрес ', h('b', { class: 'mono' }, S.info.addresses[0] || 'этого компьютера'), '.')
    )
  );

  // проверка
  const result = h('div', { class: 'stack' });
  body.append(
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Проверка'),
      h('p', { class: 'meta' }, 'Панель узнает ваш внешний адрес и спросит у роутера, какой адрес выдал ему провайдер. Если они разные — у вас «серый» IP, и без туннеля друзья не подключатся.'),
      h('div', { class: 'row' }, h('button', {
        type: 'button',
        class: 'btn',
        onclick: (e) => act(e.currentTarget, async () => {
          result.replaceChildren(h('p', { class: 'empty' }, 'Проверяю…'));
          const r = await api.call('net:check', { id: i.id }).catch((err) => {
            result.replaceChildren();
            throw err;
          });
          const rows = [h('p', null, 'Внешний адрес: ', h('b', { class: 'mono' }, r.publicIp))];
          if (r.upnp) rows.push(h('p', null, 'Адрес роутера в интернете: ', h('b', { class: 'mono' }, r.routerIp || 'неизвестен')));
          else rows.push(h('p', { class: 'meta' }, `Роутер не ответил по UPnP: ${r.upnpError}`));
          if (r.cgnat) rows.push(h('div', { class: 'banner warn' }, 'У вас «серый» IP: провайдер не выдаёт вам собственный адрес. Открытые порты не помогут — нужен туннель playit.gg, он ниже.'));
          else if (r.upnp) rows.push(h('div', { class: 'banner' }, `IP белый: друзья смогут подключаться по адресу ${r.publicIp}:${i.ports[0].port}, если порты открыты.`));
          else rows.push(h('p', { class: 'meta' }, 'Узнать, белый ли IP, не вышло. Если порты открыты, а друзья не могут зайти, — скорее всего, IP «серый», нужен туннель.'));
          rows.push(h('p', { class: 'meta' }, 'Проверить UDP-порты со своего компьютера нельзя: надёжнее всего попросить друга подключиться.'));
          result.replaceChildren(...rows);
        }),
      }, 'Проверить')),
      result
    )
  );

  // туннель
  const addr = h('input', { type: 'text', value: n.tunnel, placeholder: 'например, flower-party.gl.joinmc.link', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес туннеля' });
  body.append(
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Туннель playit.gg'),
      h('p', null, 'Нужен, если IP «серый» или порты открыть не получается. Бесплатно, у playit.gg есть туннели и для TCP, и для UDP.'),
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'Нажмите «Настроить туннель» — откроется окно playit со ссылкой. Войдите или зарегистрируйтесь на playit.gg и привяжите агента.'),
        h('li', null, `На сайте создайте туннель: тип ${ports.some((p) => p.proto === 'UDP') ? 'UDP' : 'TCP'}, локальный порт ${i.ports[0].port}.`),
        h('li', null, 'Скопируйте адрес туннеля с сайта и вставьте сюда — его увидят друзья.')
      ),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
        await api.call('net:playitSetup');
        toast('Окно playit открыто — следуйте инструкции в нём');
      }) }, 'Настроить туннель')),
      h('div', { class: 'cmd' }, addr, h('button', { type: 'button', class: 'btn', onclick: (e) => save({ tunnel: addr.value }, e.currentTarget).then(() => toast('Сохранено')) }, 'Сохранить')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.tunnelAuto, onchange: (e) => save({ tunnelAuto: e.currentTarget.checked }) }), h('span', null, 'Запускать туннель вместе с сервером'))
    )
  );
}
// файлы настроек

function tabFiles(i, body) {
  if (!i.installed) {
    body.append(h('p', { class: 'empty' }, 'Сначала установите сервер.'));
    return;
  }
  const holder = h('div', { class: 'stack' }, h('p', { class: 'empty' }, 'Загрузка…'));
  body.append(holder);
  api.call('files:list', { id: i.id }).then((list) => {
    if (!holder.isConnected) return;
    if (!list.length) return holder.replaceChildren(h('p', { class: 'empty' }, 'Для этой игры в панели нет файлов для правки. Все настройки — во вкладке «Настройки».'));
    const cur = S.file && list.find((f) => f.path === S.file) ? S.file : list[0].path;
    const area = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'Текст файла' });
    const info = h('p', { class: 'meta' });
    const saveBtn = h('button', { type: 'submit', class: 'btn primary' }, 'Сохранить');
    const open = (rel) => {
      S.file = rel;
      const f = list.find((x) => x.path === rel);
      for (const b of picker.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.path === rel));
      info.textContent = f.note;
      area.value = '';
      area.disabled = true;
      saveBtn.disabled = true;
      api.call('files:read', { id: i.id, path: rel }).then(
        (text) => {
          form.hidden = false;
          area.value = text;
          area.disabled = false;
          saveBtn.disabled = false;
        },
        (e) => {
          // Файла ещё нет — пустой редактор только запутает.
          form.hidden = true;
          info.textContent = e.message;
        }
      );
    };
    const picker = h('div', { class: 'tabs' }, list.map((f) => h('button', { type: 'button', class: 'tab', 'data-path': f.path, onclick: () => open(f.path) }, f.title)));
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          act(saveBtn, async () => {
            const r = await api.call('files:write', { id: i.id, path: S.file, text: area.value });
            toast(r.restart ? 'Сохранено. Изменения вступят в силу после перезапуска сервера.' : 'Сохранено. Прежняя версия — в папке config-backups.');
          });
        },
      },
      area,
      h('div', { class: 'row' }, saveBtn, h('span', { class: 'meta' }, 'Перед сохранением панель сохранит прежнюю версию файла.'))
    );
    holder.replaceChildren(picker, info, form);
    open(cur);
  }, (e) => holder.replaceChildren(h('p', { class: 'empty' }, e.message)));
}

// настройки: вторая папка для копий и сообщения

function mirrorField(m) {
  const input = h('input', { type: 'text', name: '__mirror', value: m.mirror, placeholder: 'например, D:\\Копии серверов', autocomplete: 'off', spellcheck: 'false' });
  const pick = S.desktop
    ? h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
        const dir = await api.call('app:pickFolder');
        if (dir) input.value = dir;
      }) }, 'Выбрать')
    : null;
  return h(
    'div',
    { class: 'field' },
    h('span', null, 'Ещё одна папка для копий'),
    h('div', { class: 'cmd' }, input, pick),
    h('span', { class: 'hint' }, 'Каждая копия ляжет и туда. Лучше другой диск или папка Яндекс Диска, OneDrive — тогда мир переживёт поломку диска. Пусто — не копировать')
  );
}

function messageRow(msg = { every: 30, text: '' }) {
  const row = h(
    'div',
    { class: 'msg-row' },
    h('input', { type: 'text', class: 'msg-text', value: msg.text, maxlength: 200, placeholder: 'Текст сообщения', 'aria-label': 'Текст сообщения' }),
    h('select', { class: 'msg-every', 'aria-label': 'Как часто' }, [10, 15, 30, 60, 120, 240].map((n) => h('option', { value: n, selected: n === msg.every }, n < 60 ? `раз в ${n} мин` : `раз в ${n / 60} ч`))),
    h('button', { type: 'button', class: 'btn small', 'aria-label': 'Убрать сообщение', onclick: () => row.remove() }, 'Убрать')
  );
  return row;
}

function readMessages(form) {
  return [...form.querySelectorAll('.msg-row')].map((r) => ({ text: r.querySelector('.msg-text').value, every: Number(r.querySelector('.msg-every').value) })).filter((x) => x.text.trim());
}

function messagesCard(i) {
  const m = i.maint;
  const g = gameById(i.game);
  const rows = h('div', { class: 'stack' }, (m.messages || []).map(messageRow));
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, 'Сообщения игрокам'),
    i.tracksPlayers
      ? h(
          'label',
          { class: 'field' },
          h('span', null, 'Приветствие при входе'),
          h('input', { type: 'text', name: '__welcome', value: m.welcome, maxlength: 200, placeholder: 'Привет, {name}! Правила — в Discord' }),
          h('span', { class: 'hint' }, '{name} заменится на имя игрока. Работает там, где сервер сообщает о входе')
        )
      : null,
    h('b', null, 'По расписанию'),
    rows,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: () => rows.querySelectorAll('.msg-row').length < 10 && rows.append(messageRow()) }, 'Добавить сообщение')),
    h('p', { class: 'meta' }, 'Сообщения уходят, только пока на сервере кто-то есть.')
  );
}

// готовый сервер из папки

function importCard() {
  const path = h('input', { type: 'text', placeholder: 'Папка сервера, например D:\\Steam\\steamapps\\common\\Valheim dedicated server', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Папка сервера' });
  const found = h('p', { class: 'meta' });
  const go = h('button', { type: 'button', class: 'btn primary', hidden: true, onclick: (e) => act(e.currentTarget, async () => {
    const v = await api.call('import:create', { path: path.value });
    S.list = await api.call('inst:list');
    select(v.id, 'console');
    toast('Копирую файлы сервера — это может занять несколько минут');
  }) }, 'Перенести');
  const check = (btn) => act(btn, async () => {
    go.hidden = true;
    const r = await api.call('import:detect', { path: path.value });
    found.textContent = `Найден сервер ${r.title}. Панель скопирует его файлы к себе — исходная папка не изменится.`;
    go.hidden = false;
  }).catch(() => {});
  const pick = S.desktop
    ? h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
        const dir = await api.call('app:pickFolder');
        if (dir) {
          path.value = dir;
          check(null);
        }
      }) }, 'Выбрать папку')
    : null;
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, 'Уже есть сервер?'),
    h('p', { class: 'meta' }, 'Если сервер уже скачан (через Steam или вручную), панель возьмёт его файлы — заново качать не придётся.'),
    h('div', { class: 'cmd' }, path, pick, h('button', { type: 'button', class: 'btn', onclick: (e) => check(e.currentTarget) }, 'Проверить')),
    found,
    h('div', { class: 'row' }, go)
  );
}

// перенос мира из одиночной игры

function worldsCard(i) {
  const list = h('div', { class: 'list' }, h('p', { class: 'empty' }, 'Ищу миры на этом компьютере…'));
  const card = h(
    'div',
    { class: 'card stack' },
    h('h2', null, 'Мир из одиночной игры'),
    h('p', { class: 'meta' }, 'Играли одни, а теперь хотите продолжить с друзьями? Выберите мир — панель перенесёт его на сервер. Нынешний мир сервера сохранится отдельной копией.'),
    list
  );
  api.call('worlds:list', { id: i.id }).then(
    (worlds) => {
      if (!worlds.length) return list.replaceChildren(h('p', { class: 'empty' }, 'На этом компьютере миров этой игры не нашлось.'));
      list.replaceChildren(
        ...worlds.map((w) =>
          h(
            'div',
            { class: 'item' },
            h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, w.name), h('div', { class: 'item-sub' }, [`изменён ${fmtDate(w.mtime)}`, fmtSize(w.size), w.where].filter(Boolean).join(' · '))),
            h(
              'button',
              {
                type: 'button',
                class: 'btn small',
                disabled: i.state !== 'stopped',
                title: i.state !== 'stopped' ? 'Сначала остановите сервер' : null,
                onclick: async (e) => {
                  const btn = e.currentTarget;
                  if (!(await confirmBox(`Перенести мир «${w.name}» на сервер?`, 'Сервер будет запускать этот мир. Нынешний мир сервера сохранится копией — его можно вернуть во вкладке «Копии».', 'Перенести'))) return;
                  act(btn, async () => {
                    await api.call('worlds:import', { id: i.id, key: w.key });
                    toast('Мир перенесён — запустите сервер');
                  });
                },
              },
              'Перенести'
            )
          )
        )
      );
    },
    (e) => list.replaceChildren(h('p', { class: 'empty' }, e.message))
  );
  return card;
}

// настройки

function tabSettings(i, body) {
  const g = gameById(i.game);
  const m = i.maint;
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        act(form.querySelector('button[type=submit]'), async () => {
          const res = await api.call('inst:update', {
            id: i.id,
            name: form.elements.__name.value,
            settings: readFields(g, form),
            maint: {
              autoRestart: form.elements.__auto.checked,
              backupBeforeStart: form.elements.__before.checked,
              backupEveryHours: Number(form.elements.__hours.value),
              backupKeep: Number(form.elements.__keep.value),
              restartEnabled: form.elements.__rs.checked,
              restartTime: form.elements.__rtime.value,
              autoUpdate: form.elements.__upd.checked,
              autostart: form.elements.__autostart.checked,
              sleepMinutes: form.elements.__sleep ? Number(form.elements.__sleep.value) : 0,
              mirror: form.elements.__mirror.value,
              welcome: form.elements.__welcome ? form.elements.__welcome.value : '',
              messages: readMessages(form),
            },
          });
          toast(res.needsRestart ? 'Сохранено. Настройки игры применятся после перезапуска сервера.' : 'Сохранено');
        });
      },
    },
    h('div', { class: 'card stack' }, h('h2', null, 'Игра'), h('div', { class: 'form' }, h('label', { class: 'field wide' }, h('span', null, 'Название в панели'), h('input', { type: 'text', name: '__name', value: i.name, maxlength: 60 })), fieldsForm(g, i.settings))),
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Надёжность'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: '__auto', checked: m.autoRestart }), h('span', null, 'Запускать снова, если сервер упал')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: '__before', checked: m.backupBeforeStart }), h('span', null, 'Делать копию мира перед каждым запуском')),
      h(
        'div',
        { class: 'form' },
        h('label', { class: 'field' }, h('span', null, 'Копии по расписанию'), h('select', { name: '__hours' }, S.info.hours.map((n) => h('option', { value: n, selected: n === m.backupEveryHours }, n ? `Каждые ${n} ч, пока сервер работает` : 'Выключены')))),
        h('label', { class: 'field' }, h('span', null, 'Сколько автоматических копий хранить'), h('input', { type: 'number', name: '__keep', min: 1, max: 100, value: m.backupKeep }), h('span', { class: 'hint' }, 'Копии, сделанные вручную, не удаляются'))
      ),
      h(
        'div',
        { class: 'form' },
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: '__rs', checked: m.restartEnabled }), h('span', null, 'Перезапускать каждый день в')),
          h('input', { type: 'time', name: '__rtime', value: m.restartTime, 'aria-label': 'Время перезапуска' }),
          h('span', { class: 'hint' }, g.console === 'none' ? 'У этой игры нет консоли — предупредить игроков заранее не получится' : 'Игроки увидят предупреждение за 10, 5 и 1 минуту')
        ),
        h(
          'div',
          { class: 'field' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: '__upd', checked: m.autoUpdate }), h('span', null, 'Обновлять сервер игры сам')),
          h('span', { class: 'hint' }, 'Раз в три часа панель проверяет новую версию и ставит её, когда на сервере никого нет. Перед обновлением делается копия')
        )
      ),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: '__autostart', checked: m.autostart }), h('span', null, 'Запускать сервер вместе с панелью')),
      i.canSleep
        ? h(
            'label',
            { class: 'field' },
            h('span', null, 'Сон, когда никого нет'),
            h('select', { name: '__sleep' }, [0, 10, 15, 30, 60].map((n) => h('option', { value: n, selected: n === m.sleepMinutes }, n ? `Выключать через ${n} мин без игроков` : 'Не выключать'))),
            h('span', { class: 'hint' }, 'Компьютер не тратит силы на пустой сервер. Разбудить — кнопкой «Запустить» или командой /on в Telegram')
          )
        : null,
      mirrorField(m)
    ),
    g.console !== 'none' && i.canSay ? messagesCard(i) : null,
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Сохранить'))
  );
  body.append(
    form,
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Файлы сервера'),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, () => api.call('inst:folder', { id: i.id })) }, 'Открыть папку'),
        i.installed
          ? h('button', {
              type: 'button',
              class: 'btn',
              onclick: (e) => act(e.currentTarget, async () => {
                const r = await api.call('inst:checkUpdate', { id: i.id });
                toast(r && r.available ? 'Вышла новая версия — нажмите «Обновить игру»' : 'Установлена последняя версия');
              }),
            }, 'Проверить обновление')
          : null,
        i.installed ? h('button', { type: 'button', class: 'btn', disabled: i.state !== 'stopped', onclick: (e) => act(e.currentTarget, () => api.call('inst:install', { id: i.id })) }, i.update && i.update.available ? 'Обновить игру' : 'Переустановить файлы игры') : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            disabled: i.state !== 'stopped',
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (!(await confirmBox(`Удалить сервер «${i.name}»?`, 'Удалятся файлы сервера, мир и все его копии. Вернуть их будет нельзя.', 'Удалить навсегда'))) return;
              act(btn, async () => {
                await api.call('inst:delete', { id: i.id });
                S.logs.delete(i.id);
                S.list = await api.call('inst:list');
                select(S.list.length ? S.list[0].id : 'new');
              });
            },
          },
          'Удалить сервер'
        )
      ),
      i.state !== 'stopped' ? h('p', { class: 'meta' }, 'Обновить или удалить можно только выключенный сервер.') : null
    )
  );
}

// моды

function tabMods(i, body) {
  const g = gameById(i.game);
  if (!i.installed) {
    body.append(h('p', { class: 'empty' }, 'Сначала установите сервер — тогда сюда можно будет добавлять моды.'));
    return;
  }
  const holder = h('div', { class: 'stack' }, h('p', { class: 'empty' }, 'Загрузка…'));
  body.append(holder);
  const locked = () => (current() || i).state !== 'stopped';

  const draw = (info) => {
    if (!holder.isConnected) return;
    const op = (btn, method, arg) => act(btn, async () => draw(await api.call(method, { id: i.id, ...arg })));
    const kids = [];
    if (locked()) kids.push(h('div', { class: 'banner warn' }, 'Моды меняются только на выключенном сервере. Остановите его, чтобы ставить и удалять.'));
    if (info.note) kids.push(h('p', { class: 'meta' }, info.note));

    if (info.frameworks.length) {
      kids.push(
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'Загрузчики модов'),
          h(
            'div',
            { class: 'list' },
            info.frameworks.map((f) =>
              h(
                'div',
                { class: 'item' },
                h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, f.title, ' ', f.installed ? h('span', { class: 'tag' }, 'установлен') : null), h('div', { class: 'item-sub' }, f.about)),
                h('button', { type: 'button', class: 'btn small', disabled: locked(), onclick: (e) => op(e.currentTarget, 'mods:framework', { fw: f.id }) }, f.installed ? 'Обновить' : 'Установить'),
                f.installed && f.removable ? h('button', { type: 'button', class: 'btn small', disabled: locked(), onclick: (e) => op(e.currentTarget, 'mods:frameworkRemove', { fw: f.id }) }, 'Убрать') : null
              )
            )
          )
        )
      );
    }

    if (info.hasCatalog) {
      const upd = h('div', { class: 'list' });
      kids.push(
        h(
          'div',
          { class: 'card stack' },
          h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Обновления модов'), h('button', {
            type: 'button',
            class: 'btn small',
            onclick: (e) => act(e.currentTarget, async () => {
              upd.replaceChildren(h('p', { class: 'empty' }, 'Проверяю…'));
              const list = await api.call('mods:checkUpdates', { id: i.id }).catch((err) => {
                upd.replaceChildren();
                throw err;
              });
              if (!list.length) return upd.replaceChildren(h('p', { class: 'empty' }, 'Все моды из каталога — последних версий.'));
              upd.replaceChildren(
                ...list.map((m) => h('div', { class: 'item' }, h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, m.title), h('div', { class: 'item-sub' }, `${m.current} → ${m.latest}`)))),
                h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary small', disabled: locked(), onclick: (ev) => op(ev.currentTarget, 'mods:update', { items: list.map((m) => m.id) }).then(() => toast('Моды обновлены')) }, `Обновить все (${list.length})`))
              );
            }),
          }, 'Проверить')),
          upd
        )
      );
      const results = h('div', { class: 'list' });
      const q = h('input', { type: 'search', placeholder: 'Название мода, например: kits', 'aria-label': 'Поиск модов' });
      const search = (btn) =>
        act(btn, async () => {
          results.replaceChildren(h('p', { class: 'empty' }, 'Ищу…'));
          const found = await api.call('mods:search', { id: i.id, q: q.value }).catch((e) => {
            results.replaceChildren();
            throw e;
          });
          if (!found.length) return results.replaceChildren(h('p', { class: 'empty' }, 'Ничего не нашлось. Попробуйте другое слово (каталог на английском).'));
          results.replaceChildren(
            ...found.map((m) =>
              h(
                'div',
                { class: 'item' },
                h(
                  'div',
                  { class: 'item-text' },
                  h('div', { class: 'item-title' }, m.title, m.version ? ' ' + m.version : ''),
                  h('div', { class: 'item-sub' }, [m.author, `${fmtNum(m.downloads)} скачиваний`].filter(Boolean).join(' · ')),
                  h('div', { class: 'item-sub' }, m.desc),
                  m.note ? h('span', { class: 'tag warn' }, m.note) : null
                ),
                h('button', { type: 'button', class: 'btn small', disabled: locked(), onclick: (e) => op(e.currentTarget, 'mods:install', { item: m.id }).then(() => toast(`${m.title}: готово`)) }, 'Установить')
              )
            )
          );
        });
      kids.push(
        h(
          'div',
          { class: 'card stack' },
          h('h2', null, 'Каталог'),
          h(
            'form',
            {
              class: 'cmd',
              onsubmit: (e) => {
                e.preventDefault();
                search(e.currentTarget.querySelector('button'));
              },
            },
            q,
            h('button', { type: 'submit', class: 'btn' }, 'Найти')
          ),
          results
        )
      );
    }

    for (const f of info.folders) {
      const file = h('input', {
        type: 'file',
        hidden: true,
        accept: f.accept.join(','),
        onchange: () => {
          const picked = file.files[0];
          file.value = '';
          if (picked) act(add, async () => draw(await api.upload(i.id, f.id, picked)));
        },
      });
      const add = h('button', { type: 'button', class: 'btn small', disabled: locked(), onclick: () => file.click() }, 'Добавить из файла');
      kids.push(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'row' }, h('h2', { class: 'grow' }, f.title), add, file),
          f.needs ? h('p', { class: 'meta' }, `Заработают после установки загрузчика ${f.needs}.`) : null,
          h(
            'div',
            { class: 'list' },
            f.items.length
              ? f.items.map((m) =>
                  h(
                    'div',
                    { class: 'item' },
                    h('div', { class: 'item-text' }, h('div', { class: 'item-title' + (m.enabled ? '' : ' off') }, m.title), h('div', { class: 'item-sub' }, [m.version && 'версия ' + m.version, fmtSize(m.size), !m.enabled && 'выключен'].filter(Boolean).join(' · '))),
                    m.dir ? null : h('button', { type: 'button', class: 'btn small', disabled: locked(), onclick: (e) => op(e.currentTarget, 'mods:toggle', { folder: f.id, name: m.name }) }, m.enabled ? 'Выключить' : 'Включить'),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'btn small',
                        disabled: locked(),
                        onclick: async (e) => {
                          const btn = e.currentTarget;
                          if (await confirmBox(`Удалить «${m.title}»?`, 'Файлы мода будут удалены с сервера.', 'Удалить')) op(btn, 'mods:remove', { folder: f.id, name: m.name });
                        },
                      },
                      'Удалить'
                    )
                  )
                )
              : h('p', { class: 'empty' }, `Пока пусто. Подходят файлы: ${f.accept.join(', ')}`)
          )
        )
      );
    }
    if (info.folders.some((f) => f.items.length)) kids.push(modTestCard(i, locked));
    if (!info.frameworks.length && !info.folders.length && !info.hasCatalog && !info.note) {
      kids.push(h('p', { class: 'empty' }, 'Для этой игры панель пока не умеет ставить моды.'));
    }
    holder.replaceChildren(...kids);
  };
  S.redrawMods = () => api.call('mods:get', { id: i.id }).then(draw, (e) => toast(e.message, true));
  S.redrawMods();
}

// поиск сломанного мода

function modTestCard(i, locked) {
  const box = h('div', { class: 'card stack', id: 'modtest' });
  const draw = (t) => {
    if (!box.isConnected && box.parentNode) return;
    const kids = [h('h2', null, 'Поиск сломанного мода')];
    if (t && !t.done) {
      kids.push(
        h('p', null, t.text || 'Готовлю…'),
        h('p', { class: 'meta' }, `Модов: ${t.total}. Пробных запусков сделано: ${t.runs}, осталось около ${t.left}.`),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: (e) => act(e.currentTarget, () => api.call('modtest:cancel', { id: i.id })) }, 'Остановить поиск'))
      );
    } else {
      if (t && t.done) {
        const r = t.result || {};
        kids.push(
          h(
            'div',
            { class: 'banner' + (r.culprit || t.error ? ' warn' : '') },
            t.error ? `Поиск прерван: ${t.error}` : r.noRepro ? 'Со всеми модами сервер запустился — сломанного мода нет.' : r.combo ? 'Каждый мод по отдельности работает: сервер ломает их сочетание.' : `Сервер ломает мод «${r.culprit}»${r.needs && r.needs.length ? ` (вместе с ним проверялись: ${r.needs.join(', ')})` : ''}. Выключите или удалите его.`
          )
        );
      }
      kids.push(
        h('p', { class: 'meta' }, 'Сервер падает при запуске из-за мода? Панель будет по очереди выключать половины модов и запускать сервер, пока не найдёт виновника. Мир перед этим сохранится и в конце вернётся, все моды встанут на место.'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', disabled: locked(), onclick: (e) => act(e.currentTarget, async () => draw(await api.call('modtest:start', { id: i.id }))) }, 'Найти сломанный мод'))
      );
    }
    box.replaceChildren(...kids);
  };
  S.drawModTest = draw;
  api.call('modtest:get', { id: i.id }).then(draw, () => draw(null));
  return box;
}

// копии

function tabBackups(i, body) {
  const listEl = h('div', { class: 'list' }, h('p', { class: 'empty' }, 'Загрузка…'));
  const load = async () => {
    const list = await api.call('backup:list', { id: i.id });
    if (!listEl.isConnected) return;
    const stopped = (current() || i).state === 'stopped';
    listEl.replaceChildren(
      ...(list.length
        ? list.map((b) =>
            h(
              'div',
              { class: 'item' },
              h('div', { class: 'item-text' }, h('div', { class: 'item-title' }, fmtDate(b.time)), h('div', { class: 'item-sub' }, `${b.reason} · ${fmtSize(b.size)}`)),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn small',
                  disabled: !stopped,
                  title: stopped ? null : 'Сначала остановите сервер',
                  onclick: async (e) => {
                    const btn = e.currentTarget;
                    if (!(await confirmBox('Вернуть мир из этой копии?', `Мир станет таким, каким был ${fmtDate(b.time)}. Нынешнее состояние сохранится отдельной копией.`, 'Восстановить'))) return;
                    act(btn, async () => {
                      await api.call('backup:restore', { id: i.id, name: b.name });
                      toast('Мир восстановлен из копии');
                    });
                  },
                },
                'Восстановить'
              ),
              h('a', { class: 'btn small', href: `/api/backup?id=${encodeURIComponent(i.id)}&name=${encodeURIComponent(b.name)}`, download: b.name }, 'Скачать'),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn small',
                  onclick: async (e) => {
                    const btn = e.currentTarget;
                    if (await confirmBox('Удалить эту копию?', `Копия от ${fmtDate(b.time)} будет удалена навсегда.`, 'Удалить')) act(btn, () => api.call('backup:delete', { id: i.id, name: b.name }));
                  },
                },
                'Удалить'
              )
            )
          )
        : [h('p', { class: 'empty' }, 'Копий пока нет. Первая появится сама перед запуском сервера, когда у него будет мир.')])
    );
  };
  S.reloadBackups = () => load().catch((e) => toast(e.message, true));
  body.append(
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h2', null, 'Резервные копии'), h('p', { class: 'meta' }, 'В копию попадают мир и настройки. Расписание — во вкладке «Настройки».')), h('button', { type: 'button', class: 'btn primary', disabled: !i.installed, onclick: (e) => act(e.currentTarget, () => api.call('backup:create', { id: i.id }).then(() => toast('Копия создана'))) }, 'Создать копию')),
      listEl
    ),
    i.worldsImport && i.installed ? worldsCard(i) : null
  );
  S.reloadBackups();
}

// ---- Telegram ----

const TG_EVENTS = [
  ['start', 'Сервер запустился'],
  ['stop', 'Сервер остановлен'],
  ['crash', 'Сервер упал'],
  ['players', 'Игрок зашёл или вышел (где сервер об этом сообщает)'],
  ['backup', 'Создана копия'],
];

function renderTg() {
  const t = S.tg || { connected: false };
  const page = h('div', { class: 'page' }, h('h1', null, 'Связь'), h('p', { class: 'lead' }, 'Уведомления в Telegram и Discord, отчёт за неделю и управление с телефона. Работает, пока запущена панель — в том числе свёрнутая к часам.'), h('h2', { class: 'section' }, 'Telegram'));
  const apply = (info) => {
    S.tg = info;
    renderSide();
    renderMain();
  };
  if (!t.connected) {
    const input = h('input', { type: 'text', name: 'token', placeholder: '123456789:AA…', autocomplete: 'off', spellcheck: 'false' });
    page.append(
      h(
        'form',
        {
          class: 'card stack',
          onsubmit: (e) => {
            e.preventDefault();
            act(e.currentTarget.querySelector('button'), async () => apply(await api.call('tg:connect', { token: input.value })));
          },
        },
        h('h2', null, 'Подключение'),
        h('ol', { class: 'steps' }, h('li', null, 'Откройте в Telegram бота @BotFather и отправьте ему команду /newbot.'), h('li', null, 'Придумайте боту имя — BotFather пришлёт токен.'), h('li', null, 'Вставьте токен сюда.')),
        h('label', { class: 'field' }, h('span', null, 'Токен бота'), input, h('span', { class: 'hint' }, 'Хранится только на этом компьютере, в папке панели.')),
        h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Подключить'))
      )
    );
    return page;
  }
  if (!t.linked) {
    page.append(
      h(
        'div',
        { class: 'card stack' },
        h('h2', null, `Бот @${t.bot} подключён. Осталось привязать чат`),
        h('p', null, 'Откройте бота в Telegram и отправьте ему сообщение:'),
        h('div', null, h('span', { class: 'code' }, `/start ${t.code}`)),
        h('p', { class: 'meta' }, 'Код действует 10 минут. Бот будет слушаться только того чата, откуда пришёл этот код. Можно добавить бота в группу с друзьями и отправить код там.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `https://t.me/${encodeURIComponent(t.bot)}?start=${t.code}`, target: '_blank', rel: 'noopener' }, 'Открыть бота'), h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => apply(await api.call('tg:disconnect'))) }, 'Отключить бота'))
      )
    );
    return page;
  }
  const save = () => {
    const events = {};
    for (const [k] of TG_EVENTS) events[k] = form.elements['ev-' + k].checked;
    act(null, async () => (S.tg = await api.call('tg:set', { events, control: form.elements.control.checked })));
  };
  const form = h(
    'form',
    { class: 'card stack', onchange: save, onsubmit: (e) => e.preventDefault() },
    h('h2', null, `Бот @${t.bot} · чат «${t.chatName || 'без названия'}»`),
    h('div', { class: 'stack' }, h('b', null, 'О чём писать'), TG_EVENTS.map(([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'ev-' + k, checked: t.events[k] }), h('span', null, label)))),
    h('div', { class: 'stack' }, h('b', null, 'Управление'), h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'control', checked: t.control }), h('span', null, 'Разрешить команды из чата: /on, /off, /restart, /backup, /cmd', h('br'), h('span', { class: 'hint meta' }, 'Команду /status бот выполняет всегда. Список команд — /help.')))),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, () => api.call('tg:test').then(() => toast('Сообщение отправлено — проверьте чат'))) }, 'Отправить проверку'), h('button', { type: 'button', class: 'btn danger', onclick: (e) => act(e.currentTarget, async () => apply(await api.call('tg:disconnect'))) }, 'Отключить бота'))
  );
  page.append(form);
  return page;
}

// Discord-бот

function discordBotCard() {
  const card = h('div', { class: 'card stack' }, h('p', { class: 'empty' }, 'Загрузка…'));
  const draw = (b) => {
    if (!b.connected) {
      const input = h('input', { type: 'text', placeholder: 'Токен бота', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Токен бота Discord' });
      card.replaceChildren(
        h('h2', null, 'Бот с командами'),
        h('p', { class: 'meta' }, 'Команды /status, /on, /off, /restart, /backup прямо в Discord. Пользоваться ими смогут те, у кого на вашем сервере Discord есть право «Управлять сервером».'),
        h('ol', { class: 'steps' }, h('li', null, 'Откройте discord.com/developers/applications → «New Application».'), h('li', null, 'Слева «Bot» → «Reset Token» → скопируйте токен.'), h('li', null, 'Вставьте токен сюда и нажмите «Подключить» — появится ссылка, чтобы добавить бота на ваш сервер Discord.')),
        h('form', { class: 'cmd', onsubmit: (e) => {
          e.preventDefault();
          act(e.currentTarget.querySelector('button'), async () => draw(await api.call('dcbot:connect', { token: input.value })));
        } }, input, h('button', { type: 'submit', class: 'btn primary' }, 'Подключить'))
      );
      return;
    }
    card.replaceChildren(
      h('h2', null, `Бот ${b.name} ${b.online ? '· на связи' : '· подключается…'}`),
      h('p', null, 'Добавьте бота на свой сервер Discord: ', h('a', { href: b.invite, target: '_blank', rel: 'noopener' }, 'ссылка для добавления'), '. Команды появятся через минуту.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: b.control, onchange: (e) => act(null, async () => draw(await api.call('dcbot:set', { control: e.currentTarget.checked }))) }), h('span', null, 'Разрешить /on, /off, /restart, /backup (команда /status работает всегда)')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn danger', onclick: (e) => act(e.currentTarget, async () => draw(await api.call('dcbot:disconnect'))) }, 'Отключить бота'))
    );
  };
  S.drawDcBot = draw;
  api.call('dcbot:get').then(draw, (e) => card.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return card;
}

// Discord

function discordCard() {
  const box = h('div', { class: 'stack' }, h('h2', { class: 'section' }, 'Discord'));
  const card = h('div', { class: 'card stack' }, h('p', { class: 'empty' }, 'Загрузка…'));
  box.append(card, discordBotCard());
  api.call('dc:get').then((d) => {
    const url = h('input', { type: 'text', value: d.url, placeholder: 'https://discord.com/api/webhooks/…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Адрес вебхука' });
    const events = h('div', { class: 'stack' }, h('b', null, 'О чём писать'), TG_EVENTS.map(([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-ev': k, checked: d.events[k], onchange: (e) => act(null, () => api.call('dc:set', { events: { [k]: e.currentTarget.checked } })) }), h('span', null, label))));
    card.replaceChildren(
      h('ol', { class: 'steps' }, h('li', null, 'В Discord откройте настройки канала → «Интеграция» → «Вебхуки» → «Новый вебхук».'), h('li', null, 'Нажмите «Скопировать URL вебхука» и вставьте его сюда.')),
      h('div', { class: 'cmd' }, url, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
        await api.call('dc:set', { url: url.value });
        toast(url.value.trim() ? 'Сохранено' : 'Discord отключён');
      }) }, 'Сохранить')),
      events,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, () => api.call('dc:test').then(() => toast('Сообщение отправлено — проверьте канал'))) }, 'Отправить проверку'))
    );
  }, (e) => card.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return box;
}

// отчёт за неделю

function reportCard() {
  return h(
    'div',
    { class: 'card stack' },
    h('h2', null, 'Отчёт за неделю'),
    h('p', { class: 'meta' }, 'По понедельникам после 10:00 панель присылает в Telegram и Discord, сколько работали серверы, кто и сколько играл, сколько было копий и падений.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
      await api.call('report:send');
      toast('Отчёт отправлен');
    }) }, 'Отправить сейчас'))
  );
}

// телефон

function phoneCard() {
  const box = h('div', { class: 'stack' }, h('h2', { class: 'section' }, 'Телефон'));
  const card = h('div', { class: 'card stack' }, h('p', { class: 'empty' }, 'Загрузка…'));
  box.append(card);
  const draw = (r) => {
    const toggle = h('input', { type: 'checkbox', checked: r.enabled, onchange: (e) => act(null, async () => draw(await api.call('remote:set', { enabled: e.currentTarget.checked }))) });
    const kids = [
      h('label', { class: 'check' }, toggle, h('span', null, 'Открывать панель с телефона и других устройств в домашней сети')),
      h('p', { class: 'meta' }, 'Из интернета панель недоступна — только из вашей Wi-Fi-сети. При первом включении Windows может спросить разрешение для сети: разрешите для частных сетей.'),
    ];
    if (r.enabled) {
      kids.push(
        h('div', { class: 'phone' },
          h('div', null, h('small', null, 'Откройте на телефоне'), ...(r.urls.length ? r.urls.map((u) => h('b', { class: 'mono' }, u)) : [h('b', null, 'адрес не найден — проверьте Wi-Fi')])),
          h('div', null, h('small', null, 'ПИН-код'), h('b', { class: 'pin' }, r.pin))
        ),
        h('p', { class: 'meta' }, `Вошли устройств: ${r.devices}. Новый ПИН-код выйдет из всех.`),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, async () => {
          if (!(await confirmBox('Сменить ПИН-код?', 'Все телефоны, которые уже вошли, придётся подключить заново.', 'Сменить'))) return;
          draw(await api.call('remote:newPin'));
        }) }, 'Новый ПИН-код'))
      );
    }
    card.replaceChildren(...kids);
  };
  api.call('remote:get').then(draw, (e) => card.replaceChildren(h('p', { class: 'empty' }, e.message)));
  return box;
}

// программа: трей и автозапуск (только в окне программы)

function appCard() {
  const box = h('div', { class: 'stack' }, h('h2', { class: 'section' }, 'Программа'));
  const card = h('div', { class: 'card stack' });
  box.append(card);
  Promise.all([api.call('app:prefs'), api.call('app:login')]).then(([prefs, login]) => {
    card.replaceChildren(
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: prefs.closeToTray, onchange: (e) => act(null, () => api.call('app:prefs', { closeToTray: e.currentTarget.checked })) }), h('span', null, 'При закрытии окна оставаться у часов, не выключая серверы')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: (e) => act(e.currentTarget, () => api.call('app:widget')) }, 'Мини-окно поверх всех окон')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: login.enabled, disabled: !login.available, onchange: (e) => act(null, () => api.call('app:login', { enabled: e.currentTarget.checked })) }), h('span', null, 'Запускать вместе с Windows', h('br'), h('span', { class: 'hint meta' }, 'Окно не откроется — панель сразу уйдёт к часам и запустит серверы с отметкой «Запускать вместе с панелью».')))
    );
  }, () => box.remove());
  return box;
}

// обновление самой программы

function renderUpdate(st) {
  const box = $('upd');
  if (!box) return;
  const mk = (text, btnText, fn) => box.replaceChildren(h('span', null, text), btnText ? h('button', { type: 'button', class: 'upd-btn', onclick: (e) => act(e.currentTarget, fn) }, btnText) : null);
  box.hidden = false;
  if (st.status === 'available') mk(`Вышла версия ${st.latest}`, st.mode === 'portable' ? 'Скачать' : 'Обновить', () => api.call('update:download'));
  else if (st.status === 'downloading') mk(`Скачиваю обновление… ${st.percent || 0}%`);
  else if (st.status === 'ready') mk('Обновление готово', 'Перезапустить', () => api.call('update:install'));
  else if (st.status === 'error' && st.manual) mk('Не удалось проверить обновления');
  else box.hidden = true;
  if (st.news && !S.newsShown) {
    S.newsShown = true;
    toast(`Игрохост обновлён до версии ${st.news.version}`);
  }
}

// ---- сборка страницы ----

function renderMain() {
  const main = $('main');
  S.redrawMods = null;
  S.reloadBackups = null;
  const cur = current();
  if (S.sel === 'tg') {
    const page = renderTg();
    page.append(reportCard(), discordCard(), phoneCard());
    if (S.desktop) page.append(appCard());
    main.replaceChildren(page);
  }
  else if (S.sel === 'new' || !cur) main.replaceChildren(renderWizard());
  else main.replaceChildren(...renderServer(cur));
  main.className = 'desk ' + (S.sel !== 'tg' && S.sel !== 'new' && cur ? 'split' : 'single');
  if (cur && S.sel === cur.id) loadHistory(cur);
  paintBadges(main);
  setBars(main);
  for (const el of main.querySelectorAll('.right, .page')) el.scrollTop = 0;
}

/** Пришёл новый список серверов: обновляем шапку и статус, не трогая вкладку (там могут печатать). */
function onInstances(list) {
  const before = current();
  S.list = list;
  renderSide();
  const now = current();
  if (S.sel !== 'new' && S.sel !== 'tg' && !now) return select(list.length ? list[0].id : 'new');
  renderSide();
  if (!now || !$('head')) return;
  $('head').replaceWith(headNode(now));
  $('status').replaceWith(statusNode(now));
  if ($('crash')) $('crash').replaceWith(crashNode(now));
  if ($('stats')) $('stats').replaceWith(statsNode(now));
  paintBadges($('main'));
  setBars($('main'));
  const changed = !before || before.state !== now.state || before.installed !== now.installed || before.busy !== now.busy;
  if (changed && S.tab === 'mods' && !now.busy) S.redrawMods ? S.redrawMods() : renderMain();
  if (changed && S.tab === 'backups' && S.reloadBackups) S.reloadBackups();
  if (changed && S.tab === 'settings' && before && (before.state === 'stopped') !== (now.state === 'stopped')) renderMain();
  if (changed && S.tab === 'mods' && before && before.installed !== now.installed) renderMain();
  const playersChanged = !before || before.players.join('|') !== now.players.join('|');
  if (S.tab === 'players' && (changed || playersChanged)) renderMain();
  if (S.tab === 'net' && before && JSON.stringify(before.netState) !== JSON.stringify(now.netState)) renderMain();
}

async function init() {
  S.info = await api.call('app:info');
  S.list = await api.call('inst:list');
  S.tg = await api.call('tg:get');
  $('app-version').textContent = `Версия ${S.info.version} · ${S.info.dataDir}`;
  $('srv-new').addEventListener('click', () => select('new'));
  $('tg-open').addEventListener('click', () => select('tg'));
  select(S.list.length ? S.list[0].id : 'new');

  const es = new EventSource('/api/events');
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('instances', onInstances);
  on('log', (p) => appendLog(p.id, { text: p.text, kind: p.kind }, p.replace));
  on('install', (p) => {
    if (p.id !== S.sel || !$('job-text')) return;
    $('job-text').textContent = `${p.text}${p.pct ? ` — ${p.pct}%` : ''}`;
    $('job-bar').style.width = p.pct + '%';
    const job = (current() || {}).job;
    if (job) job.pct = p.pct;
  });
  on('backups', (p) => {
    if (p.id === S.sel && S.tab === 'backups' && S.reloadBackups) S.reloadBackups();
  });
  on('tg', (info) => {
    S.tg = info;
    renderSide();
    if (S.sel === 'tg') renderMain();
  });
  on('toast', (p) => toast(p.text, p.error));
  on('stats', (p) => {
    const i = S.list.find((x) => x.id === p.id);
    if (!i) return;
    i.stats = p;
    if (p.id === S.sel && $('stats')) $('stats').replaceWith(statsNode(i));
  });
  on('update', renderUpdate);
  on('modtest', (p) => {
    if (p.id === S.sel && S.tab === 'mods' && S.drawModTest && $('modtest')) S.drawModTest(p);
  });
  on('dcbot', (b) => {
    if (S.sel === 'tg' && S.drawDcBot) S.drawDcBot(b);
  });
  // График обновляется раз в минуту — новые точки появляются тоже раз в минуту.
  setInterval(() => {
    const i = current();
    if (i && i.state === 'running') loadHistory(i);
  }, 60000);
  // В браузере обновлений нет: команды update:* есть только в окне программы.
  api.call('update:state').then((st) => {
    S.desktop = true;
    if (S.sel === 'tg' || S.tab === 'settings') renderMain();
    renderUpdate(st);
    if (st.status === 'off') return;
    $('app-version').append(
      ' · ',
      h('button', { type: 'button', class: 'link-btn foot-btn', onclick: (e) => act(e.currentTarget, async () => {
        const r = await api.call('update:check');
        if (r.status === 'none') toast('Установлена последняя версия');
      }) }, 'Проверить обновления')
    );
  }, () => {});
  // После перезапуска панели журналы начинаются заново.
  let lost = false;
  es.addEventListener('error', () => (lost = true));
  es.addEventListener('open', async () => {
    if (!lost) return;
    lost = false;
    S.logs.clear();
    onInstances(await api.call('inst:list'));
  });
  setInterval(() => {
    const i = current();
    if (i && i.state === 'running' && $('head')) $('head').replaceWith(headNode(i));
  }, 60000);
}

init().catch((e) => {
  $('main').replaceChildren(h('div', { class: 'page' }, h('h1', null, 'Панель не отвечает'), h('p', { class: 'lead' }, e.message)));
});
