# «Печатает» строки в скрытую консоль процесса, как будто их набрали на клавиатуре.
# Нужен для серверов, которые читают команды только с консоли, а не из перенаправленного ввода (Terraria).
# Строки приходят на стандартный ввод этого скрипта в UTF-8, по одной команде на строку.
param([int]$TargetPid)
$src = @'
using System;
using System.Runtime.InteropServices;
public static class IgrohostConIn {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct KEY_EVENT_RECORD { public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState; }
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  public struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
  static IntPtr con = IntPtr.Zero;
  public static bool Open(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return false;
    con = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    return con != IntPtr.Zero && con != new IntPtr(-1);
  }
  public static bool Send(string line) {
    string s = line + "\r";
    var recs = new INPUT_RECORD[s.Length * 2];
    for (int i = 0; i < s.Length; i++) {
      for (int d = 0; d < 2; d++) {
        var r = new INPUT_RECORD();
        r.EventType = 1;
        r.KeyEvent.bKeyDown = d == 0 ? 1 : 0;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.UnicodeChar = s[i];
        if (s[i] == '\r') { r.KeyEvent.wVirtualKeyCode = 0x0D; r.KeyEvent.wVirtualScanCode = 0x1C; }
        recs[i * 2 + d] = r;
      }
    }
    uint n;
    return WriteConsoleInputW(con, recs, (uint)recs.Length, out n);
  }
}
'@
Add-Type -TypeDefinition $src
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
if (-not [IgrohostConIn]::Open([uint32]$TargetPid)) { exit 2 }
while ($null -ne ($line = $in.ReadLine())) {
  if (-not [IgrohostConIn]::Send($line)) { exit 3 }
}
exit 0
