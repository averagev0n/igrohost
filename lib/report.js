// Итоги недели по серверам: сколько работали, кто и сколько играл, сколько было копий и падений.
// Счётчики копятся в inst.week, раз в неделю (в понедельник после 10:00) панель отправляет отчёт.

/** Понедельник текущей недели, «ГГГГ-ММ-ДД» по местному времени. */
function weekKey(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** Пора ли отправлять отчёт: понедельник после 10:00 и за эту неделю ещё не отправляли. */
function reportDue(now, lastWeek) {
  return now.getDay() === 1 && now.getHours() >= 10 && weekKey(now) !== lastWeek;
}

const emptyWeek = () => ({ uptimeMs: 0, starts: 0, crashes: 0, backups: 0, players: {} });

function hours(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
}

/** Текст отчёта. servers — [{ title, week }]. Пустые недели не попадают в отчёт. */
function reportText(servers) {
  const active = servers.filter((s) => s.week && (s.week.uptimeMs > 0 || s.week.starts > 0));
  if (!active.length) return '';
  const parts = ['📊 Итоги недели'];
  for (const s of active) {
    const w = s.week;
    const lines = [`\n${s.title}`, `Работал: ${hours(w.uptimeMs)}, запусков: ${w.starts}`];
    const top = Object.entries(w.players)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (top.length) lines.push('Играли: ' + top.map(([n, ms]) => `${n} — ${hours(ms)}`).join(', '));
    else lines.push('Игроков за неделю не было');
    if (w.backups) lines.push(`Копий: ${w.backups}`);
    if (w.crashes) lines.push(`Падений: ${w.crashes}`);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n');
}

module.exports = { weekKey, reportDue, emptyWeek, reportText, hours };
