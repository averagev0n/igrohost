// Перезапуск по расписанию с предупреждением игроков и автообновление серверов игр.
// Решения вынесены в чистые функции, чтобы их можно было проверить тестами без часов и Steam.
const fs = require('fs');
const path = require('path');
const { run } = require('./util');

const WARN_AT = [10, 5, 1]; // за сколько минут предупреждать

/**
 * Что сделать сейчас для ежедневного перезапуска в time («ЧЧ:ММ»).
 * done — Set уже сделанного сегодня («warn10», «restart»). Возвращает { action, minutes, key } или null.
 */
function restartStep(now, time, done) {
  const [h, m] = String(time).split(':').map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const left = Math.round((target - now) / 60000);
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (left <= 0 && left > -2) {
    const key = `${day} restart`;
    return done.has(key) ? null : { action: 'restart', key };
  }
  for (const w of WARN_AT) {
    if (left === w) {
      const key = `${day} warn${w}`;
      return done.has(key) ? null : { action: 'warn', minutes: w, key };
    }
  }
  return null;
}

function warnText(minutes) {
  const word = minutes === 1 ? 'минуту' : 'минут';
  return `Сервер перезапустится через ${minutes} ${word}`;
}

// ---- версии серверов игр ----

/** Номер сборки установленного Steam-приложения из appmanifest_<id>.acf. */
function localBuild(installDir, appId) {
  try {
    const text = fs.readFileSync(path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8');
    const m = /"buildid"\s+"(\d+)"/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Номер последней сборки ветки public из вывода «app_info_print». */
function parseRemoteBuild(out, appId) {
  const start = out.indexOf(`"${appId}"`);
  const text = start >= 0 ? out.slice(start) : out;
  const m = /"branches"\s*\{\s*"public"\s*\{[^}]*?"buildid"\s+"(\d+)"/.exec(text);
  return m ? m[1] : null;
}

async function remoteBuild(steamcmdExe, appId) {
  const r = await run(steamcmdExe, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(appId), '+quit'], { cwd: path.dirname(steamcmdExe), maxOut: 2000000 });
  return parseRemoteBuild(r.out, appId);
}

module.exports = { restartStep, warnText, localBuild, parseRemoteBuild, remoteBuild, WARN_AT };
