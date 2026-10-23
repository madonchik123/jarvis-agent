using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using static JarvisNative.Win32;

namespace JarvisNative
{
    internal class WinInfo
    {
        public long hwnd;
        public string title;
        public string process;
        public string exe;
        public int pid;
        public int x, y, w, h;
        public bool focused, minimized;

        public Dictionary<string, object> ToJson() => new Dictionary<string, object>
        {
            ["hwnd"] = hwnd, ["id"] = hwnd, ["title"] = title, ["process"] = process, ["app"] = string.IsNullOrEmpty(exe) ? process : exe,
            ["pid"] = pid, ["x"] = x, ["y"] = y, ["w"] = w, ["h"] = h, ["focused"] = focused, ["minimized"] = minimized
        };
    }

    /// <summary>Top-level windows: enumeration, focusing and occlusion-proof capture.</summary>
    internal static class Windows
    {
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

        static readonly Dictionary<int, (string name, string exe)> procCache = new Dictionary<int, (string, string)>();

        public static (string name, string exe) ProcessOf(int pid)
        {
            lock (procCache)
                if (procCache.TryGetValue(pid, out var v)) return v;
            string exe = "", name = "";
            var h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h != IntPtr.Zero)
            {
                var sb = new StringBuilder(1024);
                int n = sb.Capacity;
                if (QueryFullProcessImageName(h, 0, sb, ref n)) exe = sb.ToString();
                CloseHandle(h);
            }
            name = exe.Length > 0 ? Path.GetFileNameWithoutExtension(exe) : "";
            if (name.Length == 0) try { name = Process.GetProcessById(pid).ProcessName; } catch { }
            lock (procCache)
            {
                if (procCache.Count > 500) procCache.Clear();
                procCache[pid] = (name, exe);
            }
            return (name, exe);
        }

        public static WinInfo Info(IntPtr h, IntPtr fg)
        {
            var r = Bounds(h);
            GetWindowThreadProcessId(h, out uint pid);
            var (name, exe) = ProcessOf((int)pid);
            return new WinInfo { hwnd = (long)h, title = Title(h), process = name, exe = exe, pid = (int)pid, x = r.L, y = r.T, w = r.W, h = r.H, focused = h == fg, minimized = IsIconic(h) };
        }

        /// <summary>Windows a user would see in Alt+Tab (visible, not cloaked, not tool windows), top-most first.</summary>
        public static List<WinInfo> List(bool includeUntitled = false)
        {
            var fg = GetForegroundWindow();
            var me = Process.GetCurrentProcess().Id;
            var outp = new List<WinInfo>();
            foreach (var h in TopWindows())
            {
                if (!IsWindowVisible(h) || IsCloaked(h)) continue;
                int ex = GetWindowLong(h, GWL_EXSTYLE);
                if ((ex & WS_EX_TOOLWINDOW) != 0) continue;
                if (!includeUntitled && GetWindowTextLength(h) == 0) continue;
                var r = Bounds(h);
                if (r.W < 40 || r.H < 40) continue;
                var info = Info(h, fg);
                if (info.pid == me) continue;
                var cls = ClassName(h);
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd") continue;
                outp.Add(info);
            }
            return outp;
        }

        public static IntPtr Find(string query)
        {
            var q = (query ?? "").ToLowerInvariant();
            foreach (var w in List())
                if (w.title.ToLowerInvariant().Contains(q) || w.process.ToLowerInvariant() == q || w.process.ToLowerInvariant().Contains(q)) return (IntPtr)w.hwnd;
            return IntPtr.Zero;
        }

        public static WinInfo Foreground()
        {
            var h = GetForegroundWindow();
            return Info(h, h);
        }

        /// <summary>Bring a window to the front even when Windows' foreground lock says no.</summary>
        public static bool Activate(IntPtr h)
        {
            IntPtr root = GetAncestor(h, 2);
            if (root != IntPtr.Zero) h = root;
            if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(120); }
            IntPtr fg = GetForegroundWindow();
            if (fg == h) return true;
            uint fgT = GetWindowThreadProcessId(fg, out _);
            uint tgT = GetWindowThreadProcessId(h, out _);
            uint me = GetCurrentThreadId();
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            if (fgT != me) AttachThreadInput(me, fgT, true);
            if (tgT != me && tgT != fgT) AttachThreadInput(me, tgT, true);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (fgT != me) AttachThreadInput(me, fgT, false);
            if (tgT != me && tgT != fgT) AttachThreadInput(me, tgT, false);
            Thread.Sleep(80);
            if (GetForegroundWindow() != h)
            {
                SwitchToThisWindow(h, true);
                Thread.Sleep(150);
            }
            return GetForegroundWindow() == h;
        }

        /// <summary>
        /// Picture of a window via PrintWindow(PW_RENDERFULLCONTENT): works while the window is covered by others.
        /// Falls back to a screen grab when an app renders black (some GPU/video surfaces).
        /// </summary>
        public static Bitmap Capture(IntPtr h, out RECT bounds)
        {
            bounds = Bounds(h);
            GetWindowRect(h, out RECT full);
            int fw = Math.Max(1, full.W), fh = Math.Max(1, full.H);
            var bmp = new Bitmap(fw, fh, PixelFormat.Format32bppArgb);
            bool ok;
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                ok = PrintWindow(h, hdc, 2);
                g.ReleaseHdc(hdc);
            }
            // crop away the invisible resize borders so (0,0) is the visible top-left corner
            int ox = bounds.L - full.L, oy = bounds.T - full.T;
            var crop = new Rectangle(Math.Max(0, ox), Math.Max(0, oy), Math.Min(bounds.W, fw - Math.Max(0, ox)), Math.Min(bounds.H, fh - Math.Max(0, oy)));
            Bitmap result = crop.Width > 0 && crop.Height > 0 ? bmp.Clone(crop, PixelFormat.Format24bppRgb) : bmp;
            if (!ReferenceEquals(result, bmp)) bmp.Dispose();
            if (!ok || LooksBlank(result))
            {
                result.Dispose();
                result = new Bitmap(Math.Max(1, bounds.W), Math.Max(1, bounds.H), PixelFormat.Format24bppRgb);
                using (var g = Graphics.FromImage(result)) g.CopyFromScreen(bounds.L, bounds.T, 0, 0, result.Size);
            }
            return result;
        }

        static bool LooksBlank(Bitmap b)
        {
            int dark = 0, n = 0;
            for (int y = b.Height / 8; y < b.Height; y += Math.Max(1, b.Height / 12))
                for (int x = b.Width / 8; x < b.Width; x += Math.Max(1, b.Width / 12))
                {
                    var c = b.GetPixel(x, y);
                    if (c.R < 3 && c.G < 3 && c.B < 3) dark++;
                    n++;
                }
            return n > 0 && dark == n;
        }

        /// <param name="layered">also capture layered / transparent windows (Jarvis' own HUD and overlays are invisible to a plain grab)</param>
        public static Bitmap CaptureScreen(int x, int y, int w, int h, bool layered = false)
        {
            var bmp = new Bitmap(Math.Max(1, w), Math.Max(1, h), PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(x, y, 0, 0, bmp.Size, layered ? CopyPixelOperation.SourceCopy | CopyPixelOperation.CaptureBlt : CopyPixelOperation.SourceCopy);
            return bmp;
        }

        /// <summary>Downscale so the long side is at most maxDim; returns the scale factor applied (≤ 1).</summary>
        public static Bitmap Fit(Bitmap src, int maxDim, out double scale)
        {
            scale = 1;
            int m = Math.Max(src.Width, src.Height);
            if (maxDim <= 0 || m <= maxDim) return src;
            scale = (double)maxDim / m;
            var dst = new Bitmap(Math.Max(1, (int)(src.Width * scale)), Math.Max(1, (int)(src.Height * scale)), PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, 0, 0, dst.Width, dst.Height);
            }
            src.Dispose();
            return dst;
        }

        public static void SaveJpeg(Bitmap b, string path, long quality = 82)
        {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
            b.Save(path, codec, p);
        }

        /// <summary>Cheap fingerprint of a window picture, used to wait until the UI has settled.</summary>
        public static ulong Fingerprint(IntPtr h)
        {
            try
            {
                using (var b = Capture(h, out _))
                using (var s = new Bitmap(32, 32, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(s))
                    {
                        g.InterpolationMode = InterpolationMode.Bilinear;
                        g.DrawImage(b, 0, 0, 32, 32);
                    }
                    ulong hash = 1469598103934665603UL;
                    for (int y = 0; y < 32; y++)
                        for (int x = 0; x < 32; x++)
                        {
                            var c = s.GetPixel(x, y);
                            hash = (hash ^ (ulong)((c.R >> 3) | (c.G >> 3) << 5 | (c.B >> 3) << 10)) * 1099511628211UL;
                        }
                    return hash;
                }
            }
            catch { return 0; }
        }
    }
}
