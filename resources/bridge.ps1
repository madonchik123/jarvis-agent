# Jarvis Windows bridge — persistent PowerShell worker.
# Protocol: one JSON object per line on stdin  {id, cmd, ...args}
#           one JSON object per line on stdout {id, ok, result | error}
# Everything is in physical screen pixels (the process is DPI aware).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public static bool ForceForeground(IntPtr h) {
    IntPtr root = GetAncestor(h, 2); if (root != IntPtr.Zero) h = root;
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint pid; uint fgT = GetWindowThreadProcessId(fg, out pid);
    uint tgT = GetWindowThreadProcessId(h, out pid);
    uint me = GetCurrentThreadId();
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (fgT != me) AttachThreadInput(me, fgT, true);
    if (tgT != me && tgT != fgT) AttachThreadInput(me, tgT, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (fgT != me) AttachThreadInput(me, fgT, false);
    if (tgT != me && tgT != fgT) AttachThreadInput(me, tgT, false);
    System.Threading.Thread.Sleep(80);
    if (GetForegroundWindow() != h) { SwitchToThisWindow(h, true); System.Threading.Thread.Sleep(120); }
    return GetForegroundWindow() == h;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  public static List<IntPtr> Windows() {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Title(IntPtr h) { int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  public static void KeyDown(ushort vk, bool ext) { SendInput(1, new[] { Key(vk, 0, ext ? 1u : 0u) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void KeyUp(ushort vk, bool ext) { SendInput(1, new[] { Key(vk, 0, 2u | (ext ? 1u : 0u)) }, Marshal.SizeOf(typeof(INPUT))); }
  // hardware scan-code variants: DirectInput/raw-input games ignore VK-only events
  public static void KeyDownScan(ushort vk, bool ext) { SendInput(1, new[] { Key(0, (ushort)MapVirtualKey(vk, 0), 0x8u | (ext ? 1u : 0u)) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void KeyUpScan(ushort vk, bool ext) { SendInput(1, new[] { Key(0, (ushort)MapVirtualKey(vk, 0), 0x8u | 0x2u | (ext ? 1u : 0u)) }, Marshal.SizeOf(typeof(INPUT))); }
  public static void TypeUnicode(string s) {
    foreach (char c in s) {
      var a = new[] { Key(0, c, 0x4), Key(0, c, 0x4 | 0x2) };
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(4);
    }
  }
  public static void Mouse(uint flags, int data) {
    var i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = (uint)data;
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms
[void][Win]::SetProcessDPIAware()

# Chromium/Electron only expose their accessibility tree when a UIA client is "listening" (UiaClientsAreListening()).
try {
  $script:focusHandler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{ param($sender, $e) }
  [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($script:focusHandler)
} catch {}

# ---------- helpers ----------
$script:uiaCache = @{}
$script:uiaSeq = 0

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 8 -Compress)); [Console]::Out.Flush() }

$VK = @{
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'space'=0x20; 'backspace'=0x08; 'delete'=0x2E; 'del'=0x2E;
  'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22; 'left'=0x25; 'up'=0x26; 'right'=0x27; 'down'=0x28; 'insert'=0x2D;
  'ctrl'=0x11; 'control'=0x11; 'shift'=0x10; 'alt'=0x12; 'win'=0x5B; 'windows'=0x5B; 'cmd'=0x5B; 'meta'=0x5B;
  'capslock'=0x14; 'printscreen'=0x2C; 'volumeup'=0xAF; 'volumedown'=0xAE; 'mute'=0xAD; 'playpause'=0xB3; 'nexttrack'=0xB0; 'prevtrack'=0xB1
}
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }
$EXT = @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B)

function Resolve-Vk([string]$k) {
  $k = $k.ToLower().Trim()
  if ($VK.ContainsKey($k)) { return [int]$VK[$k] }
  # letters/digits: the VK code is the ASCII code, whatever the keyboard layout (VkKeyScan fails for latin letters under a Russian layout, which broke ctrl+v / ctrl+a)
  if ($k -match '^[a-z0-9]$') { return [int][char]$k.ToUpper() }
  if ($k.Length -eq 1) { $r = [Win]::VkKeyScan([char]$k); if ($r -eq -1) { throw "cannot type key '$k' with this keyboard layout" }; return ($r -band 0xFF) }
  throw "unknown key '$k'"
}

function Send-Keys([string]$combo) {
  # "ctrl+shift+t", "enter", "alt+f4"; several chords separated by space: "ctrl+a delete"
  foreach ($chord in ($combo -split '\s+' | Where-Object { $_ })) {
    $parts = $chord -split '\+' | Where-Object { $_ }
    $vks = @($parts | ForEach-Object { Resolve-Vk $_ })
    foreach ($v in $vks) { [Win]::KeyDown([uint16]$v, ($EXT -contains $v)) }
    Start-Sleep -Milliseconds 25
    [array]::Reverse($vks)
    foreach ($v in $vks) { [Win]::KeyUp([uint16]$v, ($EXT -contains $v)) }
    Start-Sleep -Milliseconds 40
  }
}

function Click-At($x, $y, $button = 'left', $count = 1) {
  [void][Win]::SetCursorPos([int]$x, [int]$y)
  Start-Sleep -Milliseconds 40
  $down = 0x2; $up = 0x4
  if ($button -eq 'right') { $down = 0x8; $up = 0x10 } elseif ($button -eq 'middle') { $down = 0x20; $up = 0x40 }
  for ($i = 0; $i -lt $count; $i++) { [Win]::Mouse($down, 0); Start-Sleep -Milliseconds 30; [Win]::Mouse($up, 0); Start-Sleep -Milliseconds 60 }
}

function Rect-Obj($r) { @{ x = [int]$r.Left; y = [int]$r.Top; w = [int]$r.Width; h = [int]$r.Height } }

function Get-Windows {
  $fg = [Win]::GetForegroundWindow()
  foreach ($h in [Win]::Windows()) {
    $r = New-Object Win+RECT
    [void][Win]::GetWindowRect($h, [ref]$r)
    $procId = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$procId)
    $pn = ''; try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    if (($r.R - $r.L) -lt 40 -or ($r.B - $r.T) -lt 40) { continue }
    @{ hwnd = [int64]$h; title = [Win]::Title($h); process = $pn; x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T; focused = ($h -eq $fg); minimized = [Win]::IsIconic($h) }
  }
}

function Focus-Window($arg) {
  $target = $null
  if ($arg.hwnd) { $target = [IntPtr][int64]$arg.hwnd }
  else {
    $q = ([string]$arg.title).ToLower()
    foreach ($h in [Win]::Windows()) {
      $t = [Win]::Title($h).ToLower()
      $procId = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$procId)
      $pn = ''; try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower() } catch {}
      if ($t.Contains($q) -or $pn -eq $q) { $target = $h; break }
    }
  }
  if (-not $target) { throw 'window not found' }
  $ok = [Win]::ForceForeground($target)
  $now = Get-Foreground
  @{ hwnd = [int64]$target; title = [Win]::Title($target); focused = $ok; foreground = $now }
}

function Take-Screenshot($arg) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height
  if ($arg.PSObject.Properties['w'] -and $arg.w) { $x = [int]$arg.x; $y = [int]$arg.y; $w = [int]$arg.w; $h = [int]$arg.h }
  elseif ($arg.PSObject.Properties['monitor'] -and $arg.monitor -eq 'primary') { $p = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x = $p.X; $y = $p.Y; $w = $p.Width; $h = $p.Height }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $g.Dispose()
  $path = [string]$arg.path
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  @{ path = $path; x = $x; y = $y; w = $w; h = $h }
}

# ---------- UI Automation ----------
$interactive = @('Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem','RadioButton','Slider','Spinner','Tab','TabItem','TreeItem','SplitButton','Document','DataItem')

function Get-UiaTree($arg) {
  $script:uiaCache = @{}; $script:uiaSeq = 0
  $root = $null
  $h0 = [IntPtr]::Zero
  if ($arg.hwnd) { $h0 = [IntPtr][int64]$arg.hwnd } else { $h0 = [Win]::GetForegroundWindow() }
  if ($h0 -eq [IntPtr]::Zero) { $w0 = Get-Windows | Where-Object { $_.process -ne 'electron' } | Select-Object -First 1; if ($w0) { $h0 = [IntPtr][int64]$w0.hwnd } }
  if ($h0 -eq [IntPtr]::Zero) { return @{ window = ''; cls = ''; elements = @(); errors = 0; firstError = 'no window' } }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h0)
  $max = 260; if ($arg.max) { $max = [int]$arg.max }
  $query = ''; if ($arg.query) { $query = ([string]$arg.query).ToLower() }
  $out = New-Object System.Collections.ArrayList
  $errCount = 0; $firstErr = ''
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  $deadline = [DateTime]::Now.AddSeconds(5)
  while ($queue.Count -gt 0 -and $out.Count -lt $max -and [DateTime]::Now -lt $deadline) {
    $item = $queue.Dequeue(); $el = $item[0]; $depth = $item[1]
    try {
      $cur = $el.Current
      $type = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $r = $cur.BoundingRectangle
      $name = [string]$cur.Name
      $visible = (-not $cur.IsOffscreen) -and ($r.Width -gt 2) -and ($r.Height -gt 2) -and (-not [double]::IsInfinity($r.X))
      $match = $true
      if ($query) { $match = $name.ToLower().Contains($query) -or ([string]$cur.AutomationId).ToLower().Contains($query) }
      if ($visible -and $match -and ($name -or $interactive -contains $type) -and $depth -gt 0) {
        $script:uiaSeq++
        $id = "e$($script:uiaSeq)"
        $script:uiaCache[$id] = $el
        $val = ''
        if ($type -eq 'Edit' -or $type -eq 'ComboBox') { try { $vp = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $val = [string]$vp.Current.Value } } catch {} }
        [void]$out.Add(@{ id = $id; type = $type; name = $name.Substring(0, [Math]::Min(140, $name.Length)); auto = [string]$cur.AutomationId; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; enabled = $cur.IsEnabled; value = $val.Substring(0, [Math]::Min(80, $val.Length)); depth = $depth })
      }
      if ($depth -lt 14) {
        $child = $walker.GetFirstChild($el)
        while ($child -ne $null) { $queue.Enqueue(@($child, ($depth + 1))); $child = $walker.GetNextSibling($child) }
      }
    } catch { $errCount++; if (-not $firstErr) { $firstErr = $_.Exception.Message } }
  }
  # Chromium/Electron only builds its accessibility tree after the first UIA client asks for it: wait and retry once.
  $cls = ''; try { $cls = [string]$root.Current.ClassName } catch {}
  if ($out.Count -lt 8 -and $cls -like 'Chrome_WidgetWin*' -and -not $arg.retried) {
    Start-Sleep -Milliseconds 1600
    $arg | Add-Member -NotePropertyName retried -NotePropertyValue $true -Force
    return Get-UiaTree $arg
  }
  @{ window = $root.Current.Name; cls = $cls; elements = $out; errors = $errCount; firstError = $firstErr }
}

function Invoke-Uia($arg) {
  $el = $script:uiaCache[[string]$arg.id]
  if (-not $el) { throw 'unknown element id (scan again)' }
  if ($arg.PSObject.Properties['text'] -and $null -ne $arg.text) {
    $vp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.SetValue([string]$arg.text); return @{ done = 'value' } }
    throw 'element does not accept text'
  }
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return @{ done = 'invoke' } }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return @{ done = 'toggle' } }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return @{ done = 'select' } }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); return @{ done = 'expand' } }
  # no pattern: the caller decides (a real click is done by the app, exactly once)
  throw 'no-pattern'
}

# ---------- OCR (Windows.Media.Ocr, built into Windows 10/11) ----------
$script:ocrReady = $false
function Init-Ocr {
  if ($script:ocrReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $script:ocrEngines = @()
  foreach ($tag in @('ru', 'en-US', 'en')) {
    try {
      $lang = New-Object Windows.Globalization.Language $tag
      if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang); if ($e) { $script:ocrEngines += $e } }
    } catch {}
  }
  if ($script:ocrEngines.Count -eq 0) { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); if ($e) { $script:ocrEngines += $e } }
  $script:ocrReady = $true
}
function Await($op, $type) {
  $task = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
function Run-Ocr($arg) {
  Init-Ocr
  if ($script:ocrEngines.Count -eq 0) { throw 'no OCR language available' }
  $path = [string]$arg.path
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ox = 0; $oy = 0; if ($arg.PSObject.Properties['ox']) { $ox = [int]$arg.ox; $oy = [int]$arg.oy }
  $wantRu = [bool]$arg.preferRu
  $best = $null
  foreach ($eng in $script:ocrEngines) {
    $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $score = ($res.Text -replace '\s', '').Length
    if ($null -eq $best -or $score -gt $best.score) { $best = @{ score = $score; res = $res; lang = $eng.RecognizerLanguage.LanguageTag } }
  }
  $lines = New-Object System.Collections.ArrayList
  foreach ($ln in $best.res.Lines) {
    $words = New-Object System.Collections.ArrayList
    foreach ($w in $ln.Words) { $r = $w.BoundingRect; [void]$words.Add(@{ t = $w.Text; x = [int]($r.X + $ox); y = [int]($r.Y + $oy); w = [int]$r.Width; h = [int]$r.Height }) }
    $x1 = ($words | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
    $y1 = ($words | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
    $x2 = ($words | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
    $y2 = ($words | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
    [void]$lines.Add(@{ text = $ln.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1); words = $words })
  }
  @{ lang = $best.lang; text = $best.res.Text; lines = $lines }
}

# ---------- launching apps ----------
$script:startApps = $null
function Get-AppList {
  if ($null -eq $script:startApps) { try { $script:startApps = @(Get-StartApps) } catch { $script:startApps = @() } }
  $script:startApps
}
function Window-Snapshot { @(Get-Windows | ForEach-Object { $_.hwnd }) }
function Find-WindowBy($q) {
  $q = ([string]$q).ToLower()
  foreach ($w in (Get-Windows)) {
    if ($w.title.ToLower().Contains($q) -or $w.process.ToLower().Contains($q)) { return $w }
  }
  return $null
}
$script:aliases = @{
  'calculator' = 'calc'; 'калькулятор' = 'calc'; 'notepad' = 'notepad'; 'блокнот' = 'notepad'; 'paint' = 'mspaint'; 'пейнт' = 'mspaint';
  'explorer' = 'explorer'; 'проводник' = 'explorer'; 'file explorer' = 'explorer'; 'cmd' = 'cmd'; 'command prompt' = 'cmd'; 'терминал' = 'wt'; 'terminal' = 'wt';
  'powershell' = 'powershell'; 'task manager' = 'taskmgr'; 'диспетчер задач' = 'taskmgr'; 'settings' = 'ms-settings:'; 'параметры' = 'ms-settings:'; 'настройки' = 'ms-settings:';
  'control panel' = 'control'; 'панель управления' = 'control'; 'snipping tool' = 'snippingtool'; 'ножницы' = 'snippingtool'; 'word' = 'winword'; 'excel' = 'excel';
  'powerpoint' = 'powerpnt'; 'chrome' = 'chrome'; 'google chrome' = 'chrome'; 'хром' = 'chrome'; 'firefox' = 'firefox'; 'edge' = 'msedge'; 'браузер' = 'msedge';
  'vivaldi' = 'vivaldi'; 'vscode' = 'code'; 'visual studio code' = 'code'; 'discord' = 'discord'; 'telegram' = 'telegram'; 'steam' = 'steam'; 'spotify' = 'spotify'
}
function Launch-App($arg) {
  $name = [string]$arg.name
  $waitMs = 6000; if ($arg.wait) { $waitMs = [int]$arg.wait }
  $before = Window-Snapshot
  $how = ''
  $q = $name.ToLower().Trim()
  $isUrlOrFile = ($name -match '^(https?://|[a-zA-Z]:\|\\|shell:|ms-[a-z\-]+:)' -or $name -match '\.(exe|lnk|txt|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip)$')
  if ($isUrlOrFile) {
    Start-Process -FilePath $name; $how = 'direct'
  } else {
    $apps = Get-AppList
    $hit = $apps | Where-Object { $_.Name.ToLower() -eq $q } | Select-Object -First 1
    if (-not $hit) { $hit = $apps | Where-Object { $_.Name.ToLower().StartsWith($q) } | Select-Object -First 1 }
    if (-not $hit) { $hit = $apps | Where-Object { $_.Name.ToLower().Contains($q) } | Select-Object -First 1 }
    if ($hit) { Start-Process "shell:AppsFolder\$($hit.AppID)"; $how = "start-menu:$($hit.Name)" }
    elseif ($script:aliases.ContainsKey($q)) { Start-Process -FilePath $script:aliases[$q]; $how = "alias:$($script:aliases[$q])" }
    else {
      $ok = $false
      try { Start-Process -FilePath $name -ErrorAction Stop; $ok = $true; $how = 'path' } catch {}
      if (-not $ok) {
        # fuzzy: closest Start-menu name (handles localized names / typos)
        $best = $null; $bestScore = 0
        foreach ($a in $apps) {
          $n = $a.Name.ToLower(); $common = 0
          foreach ($tok in ($q -split '\s+')) { if ($tok.Length -gt 2 -and $n.Contains($tok)) { $common += $tok.Length } }
          if ($common -gt $bestScore) { $bestScore = $common; $best = $a }
        }
        if ($best -and $bestScore -ge 4) { Start-Process "shell:AppsFolder\$($best.AppID)"; $how = "fuzzy:$($best.Name)" }
        else { throw "could not find an app named '$name' (not in Start menu, PATH or known aliases)" }
      }
    }
  }
  if ($how -eq 'direct' -and $name -match '^https?://') {
    Start-Sleep -Milliseconds $waitMs
    return @{ how = $how; window = (Get-Foreground) }
  }
  $deadline = [DateTime]::Now.AddMilliseconds($waitMs)
  $found = $null
  $tok = ($name -replace '^.*[\/]', '' -replace '\.\w+$', '').ToLower()
  while ([DateTime]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 250
    foreach ($w in (Get-Windows)) {
      $isNew = -not ($before -contains $w.hwnd)
      $named = $w.title.ToLower().Contains($tok) -or $w.process.ToLower().Contains($tok)
      if (($isNew -and $w.process -ne 'electron') -or ($named -and $w.process -ne 'electron')) { $found = $w; break }
    }
    if ($found) { break }
  }
  if ($found) { try { [void](Focus-Window @{ hwnd = $found.hwnd }) } catch {} }
  @{ how = $how; window = $found }
}
function Wait-Window($arg) {
  $deadline = [DateTime]::Now.AddMilliseconds([int]$arg.ms)
  while ([DateTime]::Now -lt $deadline) {
    $w = Find-WindowBy $arg.query
    if ($w) { return $w }
    Start-Sleep -Milliseconds 300
  }
  return $null
}
function Get-Foreground {
  $h = [Win]::GetForegroundWindow()
  $r = New-Object Win+RECT; [void][Win]::GetWindowRect($h, [ref]$r)
  $procId = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$procId)
  $pn = ''; try { $pn = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  @{ hwnd = [int64]$h; title = [Win]::Title($h); process = $pn; x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T }
}

# ---------- main loop ----------
Out-Json @{ id = 0; ok = $true; result = 'ready' }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $res = $null
    switch ($req.cmd) {
      'ping' { $res = 'pong' }
      'screenshot' { $res = Take-Screenshot $req }
      'ocr' { $res = Run-Ocr $req }
      'cursor' { $p = New-Object Win+POINT; [void][Win]::GetCursorPos([ref]$p); $res = @{ x = $p.X; y = $p.Y } }
      'move' { [void][Win]::SetCursorPos([int]$req.x, [int]$req.y); $res = 'ok' }
      'click' { $c = 1; if ($req.double) { $c = 2 }; $b = 'left'; if ($req.button) { $b = [string]$req.button }; Click-At $req.x $req.y $b $c; $res = 'ok' }
      'drag' {
        [void][Win]::SetCursorPos([int]$req.x1, [int]$req.y1); Start-Sleep -Milliseconds 50; [Win]::Mouse(0x2, 0)
        for ($i = 1; $i -le 12; $i++) { [void][Win]::SetCursorPos([int]($req.x1 + ($req.x2 - $req.x1) * $i / 12), [int]($req.y1 + ($req.y2 - $req.y1) * $i / 12)); Start-Sleep -Milliseconds 12 }
        Start-Sleep -Milliseconds 50; [Win]::Mouse(0x4, 0); $res = 'ok'
      }
      'scroll' {
        if ($req.PSObject.Properties['x'] -and $null -ne $req.x) { [void][Win]::SetCursorPos([int]$req.x, [int]$req.y) }
        # one wheel notch at a time: apps with smooth scrolling drop a single huge delta
        if ($req.dy) { $n = [Math]::Abs([int]$req.dy); $sg = [Math]::Sign([int]$req.dy); for ($i = 0; $i -lt $n; $i++) { [Win]::Mouse(0x800, (-1 * $sg * 120)); Start-Sleep -Milliseconds 18 } }
        if ($req.dx) { $n = [Math]::Abs([int]$req.dx); $sg = [Math]::Sign([int]$req.dx); for ($i = 0; $i -lt $n; $i++) { [Win]::Mouse(0x1000, ($sg * 120)); Start-Sleep -Milliseconds 18 } }
        $res = 'ok'
      }
      'type' { [Win]::TypeUnicode([string]$req.text); $res = 'ok' }
      'keydown' {
        foreach ($k in ([string]$req.keys -split '\+' | Where-Object { $_ })) { $v = Resolve-Vk $k; if ($req.scan) { [Win]::KeyDownScan([uint16]$v, ($EXT -contains $v)) } else { [Win]::KeyDown([uint16]$v, ($EXT -contains $v)) } }
        $res = 'ok'
      }
      'keyup' {
        $ks = @([string]$req.keys -split '\+' | Where-Object { $_ }); [array]::Reverse($ks)
        foreach ($k in $ks) { $v = Resolve-Vk $k; if ($req.scan) { [Win]::KeyUpScan([uint16]$v, ($EXT -contains $v)) } else { [Win]::KeyUp([uint16]$v, ($EXT -contains $v)) } }
        $res = 'ok'
      }
      'mousebtn' {
        $b = 'left'; if ($req.button) { $b = [string]$req.button }
        $f = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }[$b]
        if ($req.PSObject.Properties['x'] -and $null -ne $req.x) { [void][Win]::SetCursorPos([int]$req.x, [int]$req.y); Start-Sleep -Milliseconds 30 }
        if ($req.state -eq 'up') { [Win]::Mouse($f[1], 0) } else { [Win]::Mouse($f[0], 0) }
        $res = 'ok'
      }
      'keys' { Send-Keys ([string]$req.keys); $res = 'ok' }
      'windows' { $res = @(Get-Windows) }
      'launch' { $res = Launch-App $req }
      'wait_window' { $res = Wait-Window $req }
      'foreground' { $res = Get-Foreground }
      'focus' { $res = Focus-Window $req }
      'uia' { $res = Get-UiaTree $req }
      'uia_invoke' { $res = Invoke-Uia $req }
      'screen_info' {
        $res = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height; primary = $_.Primary } })
      }
      'clipboard_get' { $res = [System.Windows.Forms.Clipboard]::GetText() }
      'clipboard_set' { [System.Windows.Forms.Clipboard]::SetText([string]$req.text); $res = 'ok' }
      default { throw "unknown cmd $($req.cmd)" }
    }
    Out-Json @{ id = $req.id; ok = $true; result = $res }
  } catch {
    $rid = 0; if ($req) { $rid = $req.id }
    Out-Json @{ id = $rid; ok = $false; error = $_.Exception.Message }
  }
}
