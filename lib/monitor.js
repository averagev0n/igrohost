// Нагрузка серверов на компьютер: процессор и память.
// Сервер часто запущен через «обёртку» (cmd или PowerShell), а настоящая игра — её дочерний процесс,
// поэтому считаем всё дерево процессов. Windows переиспользует номера процессов: у давно запущенной
// программы «родителем» может числиться номер, который теперь у сервера, — такие процессы,
// запущенные раньше родителя, не считаем. Один фоновый PowerShell раз в 3 секунды печатает
// по строке на каждый наблюдаемый сервер — дешевле, чем запускать команду на каждый замер.
const os = require('os');
const { spawn } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $roots = @($line -split ' ' | Where-Object { $_ -match '^\\d+$' } | ForEach-Object { [int]$_ })
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,CreationDate
  $kids = @{}
  foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($r in $roots) {
    $cpu = [long]0; $mem = [long]0; $n = 0
    $queue = New-Object System.Collections.Queue
    if ($byId.ContainsKey($r)) { $queue.Enqueue($byId[$r]) }
    while ($queue.Count -gt 0) {
      $p = $queue.Dequeue(); $n++
      $cpu += [long]$p.UserModeTime + [long]$p.KernelModeTime
      $mem += [long]$p.WorkingSetSize
      $id = [int]$p.ProcessId
      if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { if ($c.ProcessId -ne $id -and $c.CreationDate -ge $p.CreationDate) { $queue.Enqueue($c) } } }
    }
    [Console]::Out.WriteLine(("{0} {1} {2} {3} {4}" -f $r, $cpu, $mem, $n, $now))
  }
  [Console]::Out.WriteLine('.')
}
`;

/** Пересчёт двух замеров времени процессора (в сотнях наносекунд) в проценты от всего компьютера. */
function cpuPercent(prev, cur, cores) {
  if (!prev || cur.at <= prev.at) return null;
  const busyMs = (cur.cpu - prev.cpu) / 10000;
  return Math.max(0, Math.min(100, Math.round((busyMs / (cur.at - prev.at) / cores) * 1000) / 10));
}

function createMonitor({ onSample, everyMs = 3000, spawnFn = spawn }) {
  const watched = new Map(); // pid → { key, prev }
  const cores = os.cpus().length || 1;
  let ps = null;
  let timer = null;
  let buf = '';

  function ensure() {
    if (ps || process.platform !== 'win32') return;
    ps = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true });
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const m = /^(\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(l.trim());
        if (!m) continue;
        const w = watched.get(Number(m[1]));
        if (!w || Number(m[4]) === 0) continue;
        const cur = { cpu: Number(m[2]), at: Number(m[5]) };
        const cpu = cpuPercent(w.prev, cur, cores);
        w.prev = cur;
        if (cpu === null) continue;
        onSample(w.key, {
          cpu,
          memMb: Math.round(Number(m[3]) / 1048576),
          sysFreeMb: Math.round(os.freemem() / 1048576),
          sysTotalMb: Math.round(os.totalmem() / 1048576),
        });
      }
    });
    ps.on('error', () => {});
    ps.on('close', () => {
      ps = null;
    });
    ps.stdin.on('error', () => {});
  }

  function tick() {
    if (!watched.size) return;
    ensure();
    if (ps) ps.stdin.write([...watched.keys()].join(' ') + '\n');
  }

  return {
    watch(key, pid) {
      if (!Number.isInteger(pid)) return;
      for (const [p, w] of watched) if (w.key === key) watched.delete(p);
      watched.set(pid, { key, prev: null });
      if (!timer) {
        timer = setInterval(tick, everyMs);
        timer.unref();
      }
      ensure();
    },
    unwatch(key) {
      for (const [p, w] of watched) if (w.key === key) watched.delete(p);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      if (ps) {
        try {
          ps.kill();
        } catch {
          /* уже завершён */
        }
      }
      ps = null;
      watched.clear();
    },
  };
}

module.exports = { createMonitor, cpuPercent };
