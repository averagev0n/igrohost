// Объяснение, почему сервер упал или не запустился: ищем в последних строках журнала
// известные признаки и говорим по-русски, что делать. Общие правила — для всех игр,
// у игры могут быть свои (game.crashHints) — они проверяются первыми.

const COMMON = [
  {
    re: /address already in use|Only one usage of each socket address|EADDRINUSE|bind\(\) failed|Failed to bind|port .{0,20}(?:is )?(?:already )?in use|Unable to (?:open|bind) (?:UDP |TCP )?port/i,
    title: 'Порт занят',
    advice: 'Порт сервера уже занят другой программой — например, вторым экземпляром игры или этим же сервером, который не закрылся. Закройте лишнее или смените порт в настройках.',
  },
  {
    re: /OutOfMemoryError|Out of memory|Could not reserve enough space|insufficient memory|Not enough memory|std::bad_alloc|Cannot allocate memory/i,
    title: 'Не хватило памяти',
    advice: 'Серверу не хватило оперативной памяти. Закройте лишние программы, уменьшите число игроков или размер мира; у Project Zomboid поменяйте «Память серверу».',
  },
  {
    re: /VCRUNTIME\d+|MSVCP\d+|0xc000007b|api-ms-win-[\w-]+\.dll|vcruntime|The code execution cannot proceed/i,
    title: 'Не хватает компонентов Windows',
    advice: 'Серверу нужен Microsoft Visual C++ Redistributable (x64). Установите его с сайта Microsoft и запустите сервер снова.',
  },
  {
    re: /SteamAPI_Init\(\) failed|Steam must be running|SteamGameServer_Init.*fail|Failed to initialize Steam/i,
    title: 'Не удалось подключиться к Steam',
    advice: 'Сервер не смог инициализировать Steam. Проверьте интернет и попробуйте «Проверить обновление игры» во вкладке «Настройки», чтобы докачать недостающие файлы.',
  },
  {
    re: /There is not enough space|No space left on device|disk (?:is )?full/i,
    title: 'Закончилось место на диске',
    advice: 'На диске с серверами не осталось места. Удалите старые копии во вкладке «Копии» или освободите место.',
  },
  {
    re: /Could not load file or assembly|Missing (?:mod )?dependenc|DependencyException|ModLoader|BepInEx.*(?:error|exception)|Failed to load (?:mod|plugin)|Error loading plugin/i,
    title: 'Ошибка мода',
    advice: 'Похоже, сервер упал из-за мода или плагина. Выключите недавно добавленные моды во вкладке «Моды» и запустите снова.',
  },
  {
    re: /Access (?:to the path .* )?is denied|Permission denied|UnauthorizedAccessException/i,
    title: 'Нет доступа к файлам',
    advice: 'Сервер не может записать файлы. Возможно, их держит другая программа или антивирус. Закройте её и попробуйте снова.',
  },
  {
    re: /EasyAntiCheat.*(?:fail|error)|EAC.*(?:fail|error)/i,
    title: 'Ошибка античита',
    advice: 'Не запустился античит. Если стоят моды с кодом, выключите античит в настройках сервера.',
  },
];

/**
 * Найти объяснение по последним строкам журнала. lines — [{ text }] или строки.
 * Возвращает { title, advice, line } или null.
 */
function explain(lines, gameHints = []) {
  const texts = lines.slice(-300).map((l) => (typeof l === 'string' ? l : l.text));
  for (const rule of [...gameHints, ...COMMON]) {
    for (let i = texts.length - 1; i >= 0; i--) {
      if (rule.re.test(texts[i])) return { title: rule.title, advice: rule.advice, line: texts[i].trim().slice(0, 300) };
    }
  }
  return null;
}

module.exports = { explain, COMMON };
