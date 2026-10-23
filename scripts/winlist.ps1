# Lists the visible top-level windows of Jarvis (electron) processes with size, z-order index and topmost flag.
#   powershell -File scripts/winlist.ps1
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WL {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Run(HashSet<uint> pids) {
    var res = new List<string>(); int z = 0;
    EnumWindows((h, l) => {
      z++;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      var sb = new StringBuilder(128); GetClassName(h, sb, 128);
      int ex = GetWindowLong(h, -20);
      res.Add(string.Format("z={0,-3} pid={1,-6} {2,-22} {3}x{4} at {5},{6}  topmost={7} layered={8} noactivate={9}", z, pid, sb, r.R - r.L, r.B - r.T, r.L, r.T, (ex & 0x8) != 0, (ex & 0x80000) != 0, (ex & 0x8000000) != 0));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-Process electron, Jarvis -ErrorAction SilentlyContinue | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
[WL]::Run($pids)
