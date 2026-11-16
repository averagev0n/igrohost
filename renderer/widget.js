// Мини-окно: список серверов с состоянием, игроками и нагрузкой. Данные — тот же API, что у панели.
'use strict';
const $ = (id) => document.getElementById(id);
const call = async (method, arg) => {
  const r = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, arg }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.data;
};
const STATE = { stopped: 'выключен', starting: 'запускается', running: 'работает', stopping: 'останавливается', installing: 'установка' };
let list = [];
const stats = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render() {
  const ul = $('w-list');
  ul.replaceChildren();
  // Сначала работающие: ради них мини-окно и держат поверх игры.
  const items = list.slice().sort((a, b) => (a.state === 'stopped') - (b.state === 'stopped'));
  if (!items.length) {
    ul.append(el('li', 'w-empty', 'Серверов пока нет'));
    return;
  }
  for (const i of items) {
    const li = el('li');
    const name = el('div', 'w-name', i.name);
    name.append(el('small', null, `${i.gameTitle} · ${STATE[i.state] || i.state}`));
    const s = stats.get(i.id);
    const num = i.state === 'running' ? `${i.players.length ? `${i.players.length} в игре · ` : ''}${s ? `${Math.round(s.cpu)}%` : ''}` : '';
    li.append(el('span', `w-dot ${i.state}`), name, el('span', 'w-num', num));
    ul.append(li);
  }
}

async function refresh() {
  try {
    list = await call('inst:list');
    for (const i of list) if (i.stats) stats.set(i.id, i.stats);
  } catch {
    /* панель перезапускается */
  }
  render();
}

const es = new EventSource('/api/events');
es.addEventListener('instances', (e) => {
  list = JSON.parse(e.data);
  render();
});
es.addEventListener('stats', (e) => {
  const p = JSON.parse(e.data);
  stats.set(p.id, p);
  render();
});
$('w-main').addEventListener('click', () => call('app:showMain').catch(() => {}));
$('w-close').addEventListener('click', () => call('app:widget', { close: true }).catch(() => window.close()));
refresh();
