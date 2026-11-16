// Выпуск новой версии на GitHub.
//
//   npm run release            — выпустить версию, указанную в package.json
//   npm run release -- 0.3.0   — поставить версию 0.3.0 и выпустить её
//
// Перед запуском допишите в CHANGELOG.md раздел «## 0.3.0 — ГГГГ-ММ-ДД» с описанием изменений:
// он станет описанием выпуска на GitHub.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { REPO } = require('../lib/updater');
const { changelogNotes } = require('../lib/updater');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}
const step = (msg) => console.log(`\n▶ ${msg}`);

const GH = fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
const gh = (args, opts = {}) => execFileSync(GH, args, { cwd: ROOT, encoding: 'utf8', ...opts });
const git = (args, opts = {}) => (execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }) || '').trim();

// ---- проверки ----

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const wanted = process.argv[2];
if (wanted && !/^\d+\.\d+\.\d+$/.test(wanted)) fail(`Версия должна быть вида 1.2.3, а не «${wanted}»`);
const version = wanted || pkg.version;
const tag = `v${version}`;
const repo = `${REPO.owner}/${REPO.repo}`;

const notes = changelogNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!notes) fail(`В CHANGELOG.md нет раздела «## ${version} — дата». Допишите его и запустите снова.`);

try {
  gh(['auth', 'status'], { stdio: 'pipe' });
} catch {
  fail('Нет входа в GitHub. Выполните: gh auth login');
}
try {
  gh(['release', 'view', tag, '--repo', repo], { stdio: 'pipe' });
  fail(`Версия ${version} уже выпущена. Поднимите номер версии: npm run release -- x.y.z`);
} catch (e) {
  if (e.status === undefined) throw e;
}

// В рабочей копии допустимы только правки версии и списка изменений.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(3))
  .filter((f) => !['package.json', 'package-lock.json', 'CHANGELOG.md'].includes(f));
if (dirty.length) fail(`Есть незакоммиченные изменения:\n  ${dirty.join('\n  ')}\nСначала закоммитьте их.`);

// ---- версия ----

if (pkg.version !== version) {
  step(`Ставлю версию ${version}`);
  execSync(`npm version ${version} --no-git-tag-version --allow-same-version`, { cwd: ROOT, stdio: 'ignore' });
}
if (git(['status', '--porcelain'])) {
  git(['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  git(['commit', '-m', `Версия ${version}`]);
}

// ---- сборка ----

step('Проверяю тесты');
execSync('npm test', { cwd: ROOT, stdio: 'inherit' });

step('Собираю установщик и портативную версию');
execSync('npx electron-builder --win --publish never', { cwd: ROOT, stdio: 'inherit' });

const dist = path.join(ROOT, 'dist');
const files = [
  'Igrohost-Setup.exe',
  'Igrohost-Setup.exe.blockmap',
  'latest.yml', // по нему установленная версия узнаёт об обновлении
  'Igrohost-Portable.exe',
].map((f) => path.join(dist, f));
for (const f of files) if (!fs.existsSync(f)) fail(`После сборки не найден файл ${path.basename(f)}`);

// ---- публикация ----

step(`Отправляю код и метку ${tag} на GitHub`);
let tagged = '';
try {
  tagged = git(['rev-list', '-n', '1', tag], { stdio: 'pipe' });
} catch {
  /* метки ещё нет */
}
if (!tagged) git(['tag', '-a', tag, '-m', `Версия ${version}`]);
else if (tagged !== git(['rev-parse', 'HEAD'])) fail(`Метка ${tag} уже есть и указывает на другой коммит.`);
// Отправляем с учётной записью gh, не трогая общие настройки git.
git(['-c', 'credential.helper=', '-c', `credential.helper=!'${GH.replace(/\\/g, '/')}' auth git-credential`, 'push', 'origin', 'HEAD', '--follow-tags'], { stdio: 'inherit' });

step(`Создаю выпуск ${tag}`);
const notesFile = path.join(os.tmpdir(), `igrohost-notes-${version}.md`);
fs.writeFileSync(notesFile, notes + '\n', 'utf8');
gh(['release', 'create', tag, ...files, '--repo', repo, '--title', `Версия ${version}`, '--notes-file', notesFile, '--verify-tag'], { stdio: 'inherit' });
fs.rmSync(notesFile, { force: true });

console.log(`\n✔ Готово: https://github.com/${repo}/releases/tag/${tag}\n`);
