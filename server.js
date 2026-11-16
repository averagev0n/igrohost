// Панель без окна: node server.js — и открыть адрес из консоли в браузере.
// Параметры: --port=8790 --data=D:\GameServers --token=ключ (ключ нужен только для разработки).
const { boot } = require('./lib/boot');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

boot({ dataDir: arg('data'), port: Number(arg('port')) || 8790, token: arg('token') })
  .then((panel) => {
    console.log('Игрохост запущен.');
    console.log('Серверы лежат в папке: ' + panel.dataDir);
    console.log('Откройте в браузере:   ' + panel.loginUrl);
    let closing = false;
    const quit = async () => {
      // Этот же сигнал панель сама посылает серверу при мягкой остановке — тогда выходить не нужно.
      if (closing || panel.app.runner.ctrlCRecently()) return;
      closing = true;
      if (panel.app.running()) console.log('Останавливаю серверы и сохраняю миры…');
      await panel.stop();
      process.exit(0);
    };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
  })
  .catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? 'Порт занят: панель уже запущена или укажите другой через --port=' : 'Не удалось запустить панель: ' + e.message);
    process.exit(1);
  });
