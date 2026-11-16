// Поддельный «игровой сервер» для тестов: печатает строки, как Terraria, и слушает команды.
const fs = require('fs');
const path = require('path');

console.log('Starting fake server ' + JSON.stringify(process.argv.slice(2)));
setTimeout(() => console.log('Server started'), 50);
if (process.argv.includes('--world')) {
  const dir = process.argv[process.argv.indexOf('--world') + 1];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.wld'), 'v1');
}
if (process.argv.includes('--crash')) setTimeout(() => process.exit(3), 150);
// Для поиска сломанного мода: падаем, если на месте «плохой» файл.
if (process.argv.includes('--crash-if') && fs.existsSync(process.argv[process.argv.indexOf('--crash-if') + 1])) setTimeout(() => process.exit(4), 100);
process.on('SIGINT', () => {
  console.log('Saving on Ctrl+C');
  setTimeout(() => process.exit(0), 50);
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  const parts = buf.split('\n');
  buf = parts.pop();
  for (const line of parts) {
    const cmd = line.trim();
    if (cmd === 'exit') {
      console.log('Saving world...');
      process.exit(0);
    } else if (cmd.startsWith('join ')) console.log(`${cmd.slice(5)} has joined.`);
    else if (cmd.startsWith('leave ')) console.log(`${cmd.slice(6)} has left.`);
    else console.log('echo: ' + cmd);
  }
});
setInterval(() => {}, 1000);
