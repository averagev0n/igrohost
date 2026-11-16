# Запускает сервер так, чтобы он мог получить Ctrl+C: снимает запрет на сигнал,
# который дочерние процессы наследуют от программы без консоли.
# Аргументы сервера лежат в файле, по одному на строку.
param([string]$Exe, [string]$ArgFile)
$sig = '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);'
$k = Add-Type -MemberDefinition $sig -Name W -Namespace IgrohostWrap -PassThru
[void]$k::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$a = @(Get-Content -LiteralPath $ArgFile -Encoding UTF8)
& $Exe @a
exit $LASTEXITCODE
