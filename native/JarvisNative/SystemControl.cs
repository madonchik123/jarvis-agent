using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using static JarvisNative.Win32;

namespace JarvisNative
{
    /// <summary>Volume (master and per app), window placement, desktop, screen and power helpers.</summary>
    internal static class SystemControl
    {
        // ------------------------------------------------------------------ Core Audio COM
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator
        {
            int NotImpl1();
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        }

        [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume
        {
            int RegisterControlChangeNotify(IntPtr n);
            int UnregisterControlChangeNotify(IntPtr n);
            int GetChannelCount(out int c);
            int SetMasterVolumeLevel(float db, ref Guid ctx);
            int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
            int GetMasterVolumeLevel(out float db);
            int GetMasterVolumeLevelScalar(out float level);
            int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
            int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
            int GetChannelVolumeLevel(uint ch, out float db);
            int GetChannelVolumeLevelScalar(uint ch, out float level);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
            int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }

        [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionManager2
        {
            int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
            int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
            [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
        }

        [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionEnumerator
        {
            [PreserveSig] int GetCount(out int n);
            [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
        }

        [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionControl2
        {
            // IAudioSessionControl
            [PreserveSig] int GetState(out int state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            int SetDisplayName(string n, ref Guid ctx);
            int GetIconPath(out IntPtr p);
            int SetIconPath(string p, ref Guid ctx);
            int GetGroupingParam(out Guid g);
            int SetGroupingParam(ref Guid g, ref Guid ctx);
            int RegisterAudioSessionNotification(IntPtr n);
            int UnregisterAudioSessionNotification(IntPtr n);
            // IAudioSessionControl2
            int GetSessionIdentifier(out IntPtr id);
            int GetSessionInstanceIdentifier(out IntPtr id);
            [PreserveSig] int GetProcessId(out uint pid);
            [PreserveSig] int IsSystemSoundsSession();
            int SetDuckingPreference(bool optOut);
        }

        [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ISimpleAudioVolume
        {
            int SetMasterVolume(float level, ref Guid ctx);
            int GetMasterVolume(out float level);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
            int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }

        static IMMDevice Speakers()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0 /*render*/, 1 /*multimedia*/, out var dev));
            return dev;
        }

        static IAudioEndpointVolume Endpoint()
        {
            var iid = typeof(IAudioEndpointVolume).GUID;
            Marshal.ThrowExceptionForHR(Speakers().Activate(ref iid, 23, IntPtr.Zero, out object o));
            return (IAudioEndpointVolume)o;
        }

        static Guid Ctx = Guid.Empty;

        public static Dictionary<string, object> VolumeState()
        {
            var ep = Endpoint();
            ep.GetMasterVolumeLevelScalar(out float l);
            ep.GetMute(out bool m);
            return new Dictionary<string, object> { ["level"] = (int)Math.Round(l * 100), ["muted"] = m };
        }

        public static Dictionary<string, object> Volume(string action, double level, double step)
        {
            var ep = Endpoint();
            ep.GetMasterVolumeLevelScalar(out float cur);
            switch (action)
            {
                case "set": ep.SetMasterVolumeLevelScalar((float)Math.Max(0, Math.Min(100, level)) / 100f, ref Ctx); ep.SetMute(false, ref Ctx); break;
                case "up": ep.SetMasterVolumeLevelScalar((float)Math.Min(1, cur + (step <= 0 ? 10 : step) / 100.0), ref Ctx); ep.SetMute(false, ref Ctx); break;
                case "down": ep.SetMasterVolumeLevelScalar((float)Math.Max(0, cur - (step <= 0 ? 10 : step) / 100.0), ref Ctx); break;
                case "mute": ep.SetMute(true, ref Ctx); break;
                case "unmute": ep.SetMute(false, ref Ctx); break;
                case "toggle_mute": ep.GetMute(out bool m); ep.SetMute(!m, ref Ctx); break;
                case "get": break;
                default: throw new Exception($"unknown volume action '{action}'");
            }
            return VolumeState();
        }

        /// <summary>Audio sessions (apps currently able to play sound) with their own volume.</summary>
        static IEnumerable<(string app, int pid, ISimpleAudioVolume vol)> Sessions()
        {
            var iid = typeof(IAudioSessionManager2).GUID;
            Marshal.ThrowExceptionForHR(Speakers().Activate(ref iid, 23, IntPtr.Zero, out object o));
            var mgr = (IAudioSessionManager2)o;
            Marshal.ThrowExceptionForHR(mgr.GetSessionEnumerator(out var en));
            en.GetCount(out int n);
            for (int i = 0; i < n; i++)
            {
                if (en.GetSession(i, out var s) != 0 || s == null) continue;
                if (s.IsSystemSoundsSession() == 0) continue; // S_OK means "is system sounds"
                s.GetProcessId(out uint pid);
                string name = "";
                try { name = Windows.ProcessOf((int)pid).name; } catch { }
                if (string.IsNullOrEmpty(name)) { s.GetDisplayName(out name); }
                yield return (name ?? "", (int)pid, (ISimpleAudioVolume)s);
            }
        }

        public static List<Dictionary<string, object>> AppVolumes()
        {
            var outp = new List<Dictionary<string, object>>();
            foreach (var (app, pid, vol) in Sessions())
            {
                vol.GetMasterVolume(out float l);
                vol.GetMute(out bool m);
                outp.Add(new Dictionary<string, object> { ["app"] = app, ["pid"] = pid, ["level"] = (int)Math.Round(l * 100), ["muted"] = m });
            }
            return outp;
        }

        public static List<Dictionary<string, object>> AppVolume(string app, string action, double level, double step)
        {
            var q = (app ?? "").ToLowerInvariant();
            int hits = 0;
            foreach (var (name, pid, vol) in Sessions())
            {
                if (!name.ToLowerInvariant().Contains(q)) continue;
                hits++;
                vol.GetMasterVolume(out float cur);
                switch (action)
                {
                    case "set": vol.SetMasterVolume((float)Math.Max(0, Math.Min(100, level)) / 100f, ref Ctx); vol.SetMute(false, ref Ctx); break;
                    case "up": vol.SetMasterVolume((float)Math.Min(1, cur + (step <= 0 ? 15 : step) / 100.0), ref Ctx); break;
                    case "down": vol.SetMasterVolume((float)Math.Max(0, cur - (step <= 0 ? 15 : step) / 100.0), ref Ctx); break;
                    case "mute": vol.SetMute(true, ref Ctx); break;
                    case "unmute": vol.SetMute(false, ref Ctx); break;
                }
            }
            if (hits == 0) throw new Exception($"no app named '{app}' is playing sound right now (see the list of audio apps)");
            return AppVolumes().Where(x => ((string)x["app"]).ToLowerInvariant().Contains(q)).ToList();
        }

        // ------------------------------------------------------------------ windows
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] static extern bool LockWorkStation();
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);

        /// <summary>Move/resize uses the visible frame; Windows adds invisible borders to the real window rect.</summary>
        static void Place(IntPtr h, int x, int y, int w, int hgt)
        {
            if (IsIconic(h) || IsZoomed(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(120); }
            GetWindowRect(h, out RECT full);
            var vis = Bounds(h);
            int dl = vis.L - full.L, dt = vis.T - full.T, dr = full.R - vis.R, db = full.B - vis.B;
            SetWindowPos(h, IntPtr.Zero, x - dl, y - dt, w + dl + dr, hgt + dt + db, 0x0004 | 0x0010 /*NOZORDER|NOACTIVATE*/);
        }

        public static Dictionary<string, object> Window(IntPtr h, string action, Dictionary<string, object> a, Func<string, double> num)
        {
            var screen = Screen.FromHandle(h);
            var wa = screen.WorkingArea;
            var b = Bounds(h);
            switch (action)
            {
                case "minimize": ShowWindow(h, 6); break;
                case "maximize": ShowWindow(h, 3); break;
                case "restore": ShowWindow(h, 9); break;
                case "close": PostMessage(h, 0x0010 /*WM_CLOSE*/, IntPtr.Zero, IntPtr.Zero); break;
                case "focus": Windows.Activate(h); break;
                case "move": Place(h, (int)num("x"), (int)num("y"), b.W, b.H); break;
                case "resize": Place(h, b.L, b.T, Math.Max(200, (int)num("width")), Math.Max(150, (int)num("height"))); break;
                case "center": Place(h, wa.X + (wa.Width - b.W) / 2, wa.Y + (wa.Height - b.H) / 2, b.W, b.H); break;
                case "snap_left": Place(h, wa.X, wa.Y, wa.Width / 2, wa.Height); break;
                case "snap_right": Place(h, wa.X + wa.Width / 2, wa.Y, wa.Width - wa.Width / 2, wa.Height); break;
                case "snap_top": Place(h, wa.X, wa.Y, wa.Width, wa.Height / 2); break;
                case "snap_bottom": Place(h, wa.X, wa.Y + wa.Height / 2, wa.Width, wa.Height - wa.Height / 2); break;
                case "topmost_on": SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); break;
                case "topmost_off": SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); break;
                case "next_monitor":
                    {
                        var all = Screen.AllScreens;
                        int i = Array.IndexOf(all, all.First(s => s.DeviceName == screen.DeviceName));
                        var next = all[(i + 1) % all.Length].WorkingArea;
                        Place(h, next.X + (b.L - wa.X) * next.Width / Math.Max(1, wa.Width), next.Y + (b.T - wa.Y) * next.Height / Math.Max(1, wa.Height), Math.Min(b.W, next.Width), Math.Min(b.H, next.Height));
                        break;
                    }
                default: throw new Exception($"unknown window action '{action}'");
            }
            System.Threading.Thread.Sleep(200);
            return IsWindow(h) ? Windows.Info(h, GetForegroundWindow()).ToJson() : new Dictionary<string, object> { ["closed"] = true };
        }

        // ------------------------------------------------------------------ desktop / power
        public static string Desktop(string action)
        {
            switch (action)
            {
                case "show_desktop":
                case "minimize_all":
                    {
                        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                        shell.MinimizeAll();
                        return "all windows minimised";
                    }
                case "restore_all":
                    {
                        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                        shell.UndoMinimizeALL();
                        return "windows restored";
                    }
                case "lock":
                    LockWorkStation();
                    return "locked";
                case "screen_off":
                    SendMessageTimeout((IntPtr)0xFFFF, 0x0112 /*WM_SYSCOMMAND*/, (IntPtr)0xF170 /*SC_MONITORPOWER*/, (IntPtr)2, 0x0002, 1000, out _);
                    return "screen off";
            }
            throw new Exception($"unknown desktop action '{action}'");
        }

        /// <summary>Laptop/internal display brightness (WMI); external monitors usually don't support it.</summary>
        public static int Brightness(int level)
        {
            var ps = new ProcessStartInfo("powershell.exe", $"-NoProfile -NonInteractive -Command \"$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop; Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{{Brightness={Math.Max(0, Math.Min(100, level))}; Timeout=1}} | Out-Null\"")
            { CreateNoWindow = true, UseShellExecute = false, RedirectStandardError = true };
            using (var p = Process.Start(ps))
            {
                var err = p.StandardError.ReadToEnd();
                p.WaitForExit(10000);
                if (p.ExitCode != 0) throw new Exception("this display does not support brightness control (external monitors usually don't)");
            }
            return level;
        }
    }
}
