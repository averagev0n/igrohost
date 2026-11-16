// Хранилище панели: один файл panel.json в папке данных (список серверов, Telegram).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'panel.json');
  let data = { instances: [], telegram: {}, token: '' };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* первый запуск */
  }
  if (!Array.isArray(data.instances)) data.instances = [];

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  if (!data.token) {
    data.token = crypto.randomBytes(24).toString('hex');
    save();
  }

  return {
    dataDir,
    get data() {
      return data;
    },
    save,
    get: (id) => data.instances.find((i) => i.id === id),
    dir: (id) => path.join(dataDir, 'servers', id),
  };
}

module.exports = { createStore };
