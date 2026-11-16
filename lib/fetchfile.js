// Скачивание файлов с прогрессом и распаковка архивов.
const fs = require('fs');
const path = require('path');
const { run, TAR } = require('./util');

const UA = { 'User-Agent': 'igrohost' };

async function getJson(url, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url, { headers: UA });
  } catch {
    throw new Error('Нет связи с сервером загрузок — проверьте интернет');
  }
  if (res.status === 429 || res.status === 403) throw new Error('Сайт просит подождать: слишком много запросов. Попробуйте через минуту.');
  if (!res.ok) throw new Error(`Сервер загрузок ответил ошибкой ${res.status}`);
  return res.json();
}

/** Скачать url в файл dest. onProgress(получено, всего|0). */
async function download(url, dest, { fetchFn = fetch, onProgress, signal } = {}) {
  let res;
  try {
    res = await fetchFn(url, { headers: UA, signal, redirect: 'follow' });
  } catch (e) {
    if (signal && signal.aborted) throw new Error('Отменено');
    throw new Error('Не удалось скачать файл — проверьте интернет');
  }
  if (!res.ok || !res.body) throw new Error(`Не удалось скачать файл (ошибка ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(got, total);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw signal && signal.aborted ? new Error('Отменено') : new Error('Загрузка оборвалась — попробуйте ещё раз');
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
  return dest;
}

/** Распаковать zip в папку. */
async function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = process.platform === 'win32' ? await run(TAR, ['-xf', zipPath, '-C', destDir]) : await run('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  if (r.code !== 0) throw new Error('Не удалось распаковать архив: ' + (r.out.trim().split('\n').pop() || 'файл повреждён'));
}

module.exports = { download, unzip, getJson };
