# Посылает Ctrl+C процессу с указанным номером (и всем, кто сидит в его консоли).
param([int]$TargetPid)
$sig = @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint grp);
'@
$k = Add-Type -MemberDefinition $sig -Name K -Namespace IgrohostCtrlC -PassThru
[void]$k::FreeConsole()
if (-not $k::AttachConsole([uint32]$TargetPid)) { exit 2 }
[void]$k::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not $k::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }
Start-Sleep -Milliseconds 300
exit 0
