using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using static JarvisNative.Win32;

namespace JarvisNative
{
    /// <summary>
    /// jarvis-native: JSON-lines server on stdin/stdout ({id, cmd, ...} → {id, ok, result | error}).
    ///
    /// Two command families:
    ///  * window-centric computer use (modelled on the documented Codex "window2" API): list_apps, list_windows, get_window_state
    ///    (occlusion-proof screenshot + indexed accessibility tree), click / press_key / type_text / scroll / drag / set_value /
    ///    perform_secondary_action / activate_window / paste — all addressed by window id, element index or window-relative
    ///    screenshot coordinates, each activating its window first and waiting for the UI to settle afterwards;
    ///  * screen-level primitives used by the OCR screen map and routines (screenshot, ocr, uia, click, keys, type, ...).
    /// Requests run concurrently; anything that touches the real mouse/keyboard is serialised.
    /// </summary>
    internal static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        static readonly object outGate = new object();
        static readonly object inputGate = new object();
        static readonly BlockingCollection<Action> sta = new BlockingCollection<Action>();
        // window id -> scale of its latest screenshot (screenshot px / physical px)
        static readonly ConcurrentDictionary<long, double> scales = new ConcurrentDictionary<long, double>();
        static string tmpDir;
        static int busy;
        static DateTime lastRequest = DateTime.UtcNow;

        [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr h, IntPtr min, IntPtr max);

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { }
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            tmpDir = Path.Combine(Path.GetTempPath(), "jarvis-native");
            Directory.CreateDirectory(tmpDir);

            // one STA thread for COM (Shell apps folder) and the clipboard
            var staThread = new Thread(() => { foreach (var a in sta.GetConsumingEnumerable()) { try { a(); } catch { } } }) { IsBackground = true };
            staThread.SetApartmentState(ApartmentState.STA);
            staThread.Start();

            Uia.WarmUp();
            Write(new Dictionary<string, object> { ["id"] = 0, ["ok"] = true, ["result"] = "ready" });

            // give memory back to Windows when idle (UIA / imaging caches grow during a scan)
            var trim = new System.Threading.Timer(_ =>
            {
                if (Interlocked.CompareExchange(ref busy, 0, 0) == 0 && (DateTime.UtcNow - lastRequest).TotalSeconds > 4)
                {
                    GC.Collect();
                    GC.WaitForPendingFinalizers();
                    SetProcessWorkingSetSize(System.Diagnostics.Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1));
                }
            }, null, 5000, 5000);

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                var l = line;
                lastRequest = DateTime.UtcNow;
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Interlocked.Increment(ref busy);
                    try { Handle(l); } finally { Interlocked.Decrement(ref busy); lastRequest = DateTime.UtcNow; }
                });
            }
            GC.KeepAlive(trim);
        }

        static void Write(object o)
        {
            var s = Json.Serialize(o);
            lock (outGate)
            {
                Console.Out.WriteLine(s);
                Console.Out.Flush();
            }
        }

        static void Handle(string line)
        {
            object id = 0;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.TryGetValue("id", out var i) ? i : 0;
                var res = Dispatch(Str(req, "cmd"), req);
                Write(new Dictionary<string, object> { ["id"] = id, ["ok"] = true, ["result"] = res });
            }
            catch (Exception e)
            {
                var ex = e is AggregateException ae && ae.InnerException != null ? ae.InnerException : e;
                Write(new Dictionary<string, object> { ["id"] = id, ["ok"] = false, ["error"] = ex.Message });
            }
        }

        // ---------------------------------------------------------------------------------------- arg helpers
        static string Str(Dictionary<string, object> a, string k, string d = null) => a.TryGetValue(k, out var v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : d;
        static bool Has(Dictionary<string, object> a, string k) => a.TryGetValue(k, out var v) && v != null;
        static int Int(Dictionary<string, object> a, string k, int d = 0) => Has(a, k) ? (int)Math.Round(Convert.ToDouble(a[k], System.Globalization.CultureInfo.InvariantCulture)) : d;
        static double Dbl(Dictionary<string, object> a, string k, double d = 0) => Has(a, k) ? Convert.ToDouble(a[k], System.Globalization.CultureInfo.InvariantCulture) : d;
        static bool Bool(Dictionary<string, object> a, string k, bool d = false) => Has(a, k) ? (a[k] is bool b ? b : Str(a, k) == "true") : d;

        static T OnSta<T>(Func<T> f)
        {
            var tcs = new TaskCompletionSource<T>();
            sta.Add(() => { try { tcs.SetResult(f()); } catch (Exception e) { tcs.SetException(e); } });
            return tcs.Task.GetAwaiter().GetResult();
        }

        /// <summary>The window a request targets: {window: id} / {window: {id}} / {hwnd} / {app: name}.</summary>
        static IntPtr Target(Dictionary<string, object> a, bool required = true)
        {
            long id = 0;
            if (a.TryGetValue("window", out var w) && w != null)
            {
                if (w is Dictionary<string, object> d) { if (d.TryGetValue("id", out var x)) id = Convert.ToInt64(x); }
                else if (!long.TryParse(Convert.ToString(w), out id)) id = (long)Windows.Find(Convert.ToString(w));
            }
            if (id == 0 && Has(a, "hwnd")) id = Convert.ToInt64(a["hwnd"]);
            if (id == 0 && Has(a, "app")) id = (long)Windows.Find(Str(a, "app"));
            var h = (IntPtr)id;
            if (required && (id == 0 || !IsWindow(h))) throw new Exception("window not found or closed: call list_windows / list_apps for current ids");
            return h;
        }

        /// <summary>Window-relative screenshot coordinates → screen pixels.</summary>
        static Point ToScreen(IntPtr h, double x, double y)
        {
            var r = Bounds(h);
            double s = scales.TryGetValue((long)h, out var v) && v > 0 ? v : 1;
            return new Point(r.L + (int)Math.Round(x / s), r.T + (int)Math.Round(y / s));
        }

        static string Owner(Point p, IntPtr expected)
        {
            var at = WindowFromPoint(new POINT { X = p.X, Y = p.Y });
            var root = GetAncestor(at, 2);
            if (root == GetAncestor(expected, 2) || root == expected) return null;
            GetWindowThreadProcessId(root, out uint pid);
            return Windows.ProcessOf((int)pid).name + ".exe";
        }

        /// <summary>Wait until the window stops changing (after an action): ~0.3–1 s normally, up to maxMs while it is busy.</summary>
        static int Settle(IntPtr h, int maxMs)
        {
            if (maxMs <= 0 || h == IntPtr.Zero) return 0;
            var t0 = DateTime.UtcNow;
            Thread.Sleep(200);
            ulong last = Windows.Fingerprint(h);
            int same = 0;
            while ((DateTime.UtcNow - t0).TotalMilliseconds < maxMs)
            {
                Thread.Sleep(180);
                ulong now = Windows.Fingerprint(h);
                if (now == last) { if (++same >= 2) break; }
                else { same = 0; last = now; }
            }
            return (int)(DateTime.UtcNow - t0).TotalMilliseconds;
        }

        static Dictionary<string, object> Done(IntPtr h, Dictionary<string, object> a, string what, string warning = null)
        {
            int ms = Settle(h, Int(a, "settle", 3500));
            var r = new Dictionary<string, object> { ["done"] = what, ["settledMs"] = ms };
            if (warning != null) r["warning"] = warning;
            if (h != IntPtr.Zero && IsWindow(h)) r["window"] = Windows.Info(h, GetForegroundWindow()).ToJson();
            else r["window"] = null;
            return r;
        }

        // ---------------------------------------------------------------------------------------- dispatch
        static object Dispatch(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                case "ping": return "pong";

                // ------------------------------------------------ windows & apps
                case "windows":
                case "list_windows":
                    return Windows.List().Select(w => w.ToJson()).ToList();
                case "foreground": return Windows.Foreground().ToJson();
                case "focus":
                case "activate_window":
                    {
                        IntPtr h = Has(a, "title") && !Has(a, "window") && !Has(a, "hwnd") ? Windows.Find(Str(a, "title")) : Target(a, false);
                        if (h == IntPtr.Zero) throw new Exception("window not found");
                        bool ok;
                        lock (inputGate) ok = Windows.Activate(h);
                        return new Dictionary<string, object> { ["hwnd"] = (long)h, ["title"] = Title(h), ["focused"] = ok, ["foreground"] = Windows.Foreground().ToJson() };
                    }
                case "list_apps":
                    {
                        var wins = Windows.List();
                        var running = wins.GroupBy(w => string.IsNullOrEmpty(w.exe) ? w.process : w.exe, StringComparer.OrdinalIgnoreCase).Select(g => new Dictionary<string, object>
                        {
                            ["id"] = g.Key, ["displayName"] = g.First().process, ["isRunning"] = true,
                            ["windows"] = g.Select(w => new Dictionary<string, object> { ["id"] = w.hwnd, ["app"] = g.Key, ["title"] = w.title, ["focused"] = w.focused, ["minimized"] = w.minimized }).ToList()
                        }).ToList();
                        var installed = Bool(a, "installed", true) ? OnSta(Apps.Installed).Select(x => new Dictionary<string, object> { ["id"] = x.id, ["displayName"] = x.name }).ToList() : new List<Dictionary<string, object>>();
                        return new Dictionary<string, object> { ["running"] = running, ["installed"] = installed };
                    }
                case "launch":
                case "launch_app":
                    return Apps.Launch(Str(a, "name") ?? Str(a, "app"), Int(a, "wait", 7000), () => OnSta(Apps.Installed));
                case "wait_window":
                    {
                        var deadline = DateTime.UtcNow.AddMilliseconds(Int(a, "ms", 5000));
                        while (DateTime.UtcNow < deadline)
                        {
                            var h = Windows.Find(Str(a, "query"));
                            if (h != IntPtr.Zero) return Windows.Info(h, GetForegroundWindow()).ToJson();
                            Thread.Sleep(300);
                        }
                        return null;
                    }

                // ------------------------------------------------ window state
                case "get_window_state":
                    {
                        var h = Target(a);
                        var res = new Dictionary<string, object>();
                        double scale = 1;
                        if (Bool(a, "include_screenshot", true))
                        {
                            Bitmap bmp = Windows.Capture(h, out var bounds);
                            bmp = Windows.Fit(bmp, Int(a, "max_dim", 1600), out scale);
                            var path = Str(a, "path") ?? Path.Combine(tmpDir, $"win-{(long)h}-{DateTime.UtcNow.Ticks}.jpg");
                            Windows.SaveJpeg(bmp, path);
                            res["screenshot"] = new Dictionary<string, object> { ["path"] = path, ["width"] = bmp.Width, ["height"] = bmp.Height, ["scale"] = scale, ["originX"] = bounds.L, ["originY"] = bounds.T };
                            bmp.Dispose();
                        }
                        else if (scales.TryGetValue((long)h, out var s0)) scale = s0;
                        scales[(long)h] = scale;
                        if (Bool(a, "include_text", true))
                        {
                            var t = Uia.WindowTree(h, Int(a, "max_nodes", 450), Int(a, "text_limit", 200), scale);
                            res["accessibility"] = new Dictionary<string, object> { ["tree"] = t.tree, ["count"] = t.count, ["truncated"] = t.truncated, ["focused_element"] = t.focused, ["selected_text"] = t.selectedText, ["document_text"] = t.documentText };
                        }
                        res["window"] = Windows.Info(h, GetForegroundWindow()).ToJson();
                        return res;
                    }
                case "ocr_window":
                    {
                        var h = Target(a);
                        using (var bmp = Windows.Capture(h, out var bounds))
                        {
                            var p = Path.Combine(tmpDir, $"ocr-{DateTime.UtcNow.Ticks}.png");
                            bmp.Save(p, System.Drawing.Imaging.ImageFormat.Png);
                            try { return Ocr.RunFile(p, bounds.L, bounds.T); } finally { try { File.Delete(p); } catch { } }
                        }
                    }

                // ------------------------------------------------ window-relative input (window2 style)
                case "click" when Has(a, "window") || Has(a, "element_index"):
                    {
                        var h = Target(a);
                        string button = Str(a, "mouse_button") ?? Str(a, "button") ?? "left";
                        int count = Int(a, "click_count", Bool(a, "double") ? 2 : 1);
                        string how, warn = null;
                        lock (inputGate)
                        {
                            Windows.Activate(h);
                            if (Has(a, "element_index"))
                            {
                                int idx = Int(a, "element_index");
                                var (x, y, visible) = Uia.ElementPoint((long)h, idx);
                                var pt = new Point(x, y);
                                if (visible && (x != 0 || y != 0) && Owner(pt, h) == null)
                                {
                                    Input.Click(x, y, button, count);
                                    how = $"clicked element {idx}";
                                }
                                else
                                {
                                    try { how = $"element {idx}: {Uia.Invoke((long)h, idx)} (not visible for a mouse click)"; }
                                    catch
                                    {
                                        if (x == 0 && y == 0) throw new Exception($"element {idx} has no position and no invoke action");
                                        warn = Owner(pt, h) is string o ? $"point is over {o}" : null;
                                        Input.Click(x, y, button, count);
                                        how = $"clicked element {idx}";
                                    }
                                }
                            }
                            else
                            {
                                var pt = ToScreen(h, Dbl(a, "x"), Dbl(a, "y"));
                                if (Owner(pt, h) is string o) warn = $"point is over {o}, not the target window";
                                Input.Click(pt.X, pt.Y, button, count);
                                how = $"clicked at {pt.X},{pt.Y}";
                            }
                        }
                        return Done(h, a, how, warn);
                    }
                case "press_key":
                    {
                        var h = Target(a, false);
                        lock (inputGate)
                        {
                            if (h != IntPtr.Zero) Windows.Activate(h);
                            Input.Keys(Str(a, "key") ?? Str(a, "keys"), Bool(a, "scan"));
                        }
                        return Done(h, a, "pressed " + Str(a, "key"));
                    }
                case "type_text":
                    {
                        var h = Target(a, false);
                        lock (inputGate)
                        {
                            if (h != IntPtr.Zero) Windows.Activate(h);
                            Input.TypeText(Str(a, "text") ?? "", Int(a, "char_delay", 4));
                        }
                        return Done(h, a, $"typed {(Str(a, "text") ?? "").Length} characters");
                    }
                case "scroll" when Has(a, "window"):
                    {
                        var h = Target(a);
                        lock (inputGate)
                        {
                            Windows.Activate(h);
                            var pt = Has(a, "x") ? ToScreen(h, Dbl(a, "x"), Dbl(a, "y")) : ToScreen(h, Bounds(h).W / 2.0 * (scales.TryGetValue((long)h, out var s) ? s : 1), Bounds(h).H / 2.0 * (scales.TryGetValue((long)h, out var s2) ? s2 : 1));
                            SetCursorPos(pt.X, pt.Y);
                            Thread.Sleep(30);
                            // deltas are pixels like a trackpad; one wheel notch ≈ 100 px
                            int ny = (int)Math.Round(Dbl(a, "scrollY") / 100.0), nx = (int)Math.Round(Dbl(a, "scrollX") / 100.0);
                            if (ny == 0 && Dbl(a, "scrollY") != 0) ny = Math.Sign(Dbl(a, "scrollY"));
                            if (nx == 0 && Dbl(a, "scrollX") != 0) nx = Math.Sign(Dbl(a, "scrollX"));
                            Input.Wheel(ny, nx);
                        }
                        return Done(h, a, "scrolled");
                    }
                case "drag" when Has(a, "window"):
                    {
                        var h = Target(a);
                        lock (inputGate)
                        {
                            Windows.Activate(h);
                            var p1 = ToScreen(h, Dbl(a, "from_x"), Dbl(a, "from_y"));
                            var p2 = ToScreen(h, Dbl(a, "to_x"), Dbl(a, "to_y"));
                            Input.Drag(p1.X, p1.Y, p2.X, p2.Y, Str(a, "button") ?? "left");
                        }
                        return Done(h, a, "dragged");
                    }
                case "set_value":
                    {
                        var h = Target(a);
                        int idx = Int(a, "element_index");
                        var value = Str(a, "value") ?? "";
                        string how;
                        lock (inputGate)
                        {
                            how = Uia.SetValue((long)h, idx, value);
                            if (how == "")
                            {
                                // no value pattern (custom-drawn field): focus it and type like a person
                                Windows.Activate(h);
                                var (x, y, _) = Uia.ElementPoint((long)h, idx);
                                if (x != 0 || y != 0) Input.Click(x, y); else Uia.Focus((long)h, idx);
                                Thread.Sleep(120);
                                Input.Keys("ctrl+a");
                                Input.Keys("delete");
                                Input.TypeText(value);
                                how = "typed";
                            }
                        }
                        return Done(h, a, $"set value of element {idx} ({how})");
                    }
                case "perform_secondary_action":
                    {
                        var h = Target(a);
                        string r;
                        lock (inputGate) r = Uia.Secondary((long)h, Int(a, "element_index"), Str(a, "action"));
                        return Done(h, a, r);
                    }
                case "paste":
                    {
                        var h = Target(a, false);
                        var text = Str(a, "text") ?? "";
                        var format = (Str(a, "format") ?? "text").ToLowerInvariant();
                        lock (inputGate)
                        {
                            var old = OnSta(() => { try { return Clipboard.ContainsText() ? Clipboard.GetText() : null; } catch { return null; } });
                            OnSta(() =>
                            {
                                var data = new DataObject();
                                data.SetText(format == "html" ? StripTags(text) : text);
                                if (format == "html") data.SetData(DataFormats.Html, HtmlClipboard(text));
                                Clipboard.SetDataObject(data, true, 5, 60);
                                return 0;
                            });
                            if (h != IntPtr.Zero) Windows.Activate(h);
                            Thread.Sleep(60);
                            Input.Keys("ctrl+v");
                            Thread.Sleep(250);
                            if (old != null) OnSta(() => { try { Clipboard.SetText(old); } catch { } return 0; });
                        }
                        return Done(h, a, $"pasted {text.Length} characters ({format})");
                    }
                case "wait_settle":
                    {
                        var h = Target(a);
                        return new Dictionary<string, object> { ["settledMs"] = Settle(h, Int(a, "ms", 5000)) };
                    }

                // ------------------------------------------------ system: volume, windows, desktop
                case "volume":
                    {
                        var app = Str(a, "app");
                        var act = Str(a, "action") ?? "get";
                        if (act == "apps") return SystemControl.AppVolumes();
                        if (!string.IsNullOrWhiteSpace(app)) return SystemControl.AppVolume(app, act, Dbl(a, "level"), Dbl(a, "step"));
                        return SystemControl.Volume(act, Dbl(a, "level"), Dbl(a, "step"));
                    }
                case "window_control":
                    {
                        var h = Target(a);
                        lock (inputGate) return SystemControl.Window(h, Str(a, "action"), a, k => Dbl(a, k));
                    }
                case "desktop":
                    {
                        var act = Str(a, "action");
                        if (act == "brightness") return SystemControl.Brightness(Int(a, "level", 50));
                        lock (inputGate) return OnSta(() => SystemControl.Desktop(act));
                    }

                // ------------------------------------------------ screen-level primitives (OCR map, routines, games)
                case "screenshot":
                    {
                        Rectangle b = SystemInformation.VirtualScreen;
                        if (Has(a, "w")) b = new Rectangle(Int(a, "x"), Int(a, "y"), Int(a, "w"), Int(a, "h"));
                        else if (Str(a, "monitor") == "primary") b = Screen.PrimaryScreen.Bounds;
                        using (var bmp = Windows.CaptureScreen(b.X, b.Y, b.Width, b.Height, Bool(a, "layered")))
                        {
                            var path = Str(a, "path");
                            if (path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)) Windows.SaveJpeg(bmp, path);
                            else bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                            return new Dictionary<string, object> { ["path"] = path, ["x"] = b.X, ["y"] = b.Y, ["w"] = b.Width, ["h"] = b.Height };
                        }
                    }
                case "ocr": return Ocr.RunFile(Str(a, "path"), Int(a, "ox"), Int(a, "oy"));
                case "ocr_langs": return Ocr.Languages();
                case "cursor":
                    {
                        GetCursorPos(out POINT p);
                        return new Dictionary<string, object> { ["x"] = p.X, ["y"] = p.Y };
                    }
                case "move":
                    lock (inputGate) SetCursorPos(Int(a, "x"), Int(a, "y"));
                    return "ok";
                case "click":
                    lock (inputGate) Input.Click(Int(a, "x"), Int(a, "y"), Str(a, "button") ?? "left", Bool(a, "double") ? 2 : Int(a, "count", 1));
                    return "ok";
                case "drag":
                    lock (inputGate) Input.Drag(Int(a, "x1"), Int(a, "y1"), Int(a, "x2"), Int(a, "y2"), Str(a, "button") ?? "left");
                    return "ok";
                case "scroll":
                    lock (inputGate)
                    {
                        if (Has(a, "x")) SetCursorPos(Int(a, "x"), Int(a, "y"));
                        Input.Wheel(Int(a, "dy"), Int(a, "dx"));
                    }
                    return "ok";
                case "type":
                    lock (inputGate) Input.TypeText(Str(a, "text") ?? "", Int(a, "char_delay", 4));
                    return "ok";
                case "keys":
                    lock (inputGate) Input.Keys(Str(a, "keys"), Bool(a, "scan"));
                    return "ok";
                case "keydown":
                    lock (inputGate) Input.HoldDown(Str(a, "keys"), Bool(a, "scan"));
                    return "ok";
                case "keyup":
                    lock (inputGate) Input.HoldUp(Str(a, "keys"), Bool(a, "scan"));
                    return "ok";
                case "mousebtn":
                    lock (inputGate)
                    {
                        if (Has(a, "x")) { SetCursorPos(Int(a, "x"), Int(a, "y")); Thread.Sleep(30); }
                        Input.Button(Str(a, "button") ?? "left", Str(a, "state") != "up");
                    }
                    return "ok";
                case "uia":
                    {
                        IntPtr h = Has(a, "hwnd") ? (IntPtr)Convert.ToInt64(a["hwnd"]) : GetForegroundWindow();
                        return Uia.FlatScan(h, Int(a, "max", 260), Str(a, "query"));
                    }
                case "uia_invoke": return Uia.FlatInvoke(Str(a, "id"), Has(a, "text") ? Str(a, "text") : null);
                case "screen_info":
                    return Screen.AllScreens.Select(s => new Dictionary<string, object> { ["x"] = s.Bounds.X, ["y"] = s.Bounds.Y, ["w"] = s.Bounds.Width, ["h"] = s.Bounds.Height, ["primary"] = s.Primary }).ToList();
                case "clipboard_get": return OnSta(() => { try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; } catch { return ""; } });
                case "clipboard_set":
                    OnSta(() => { Clipboard.SetDataObject(Str(a, "text") ?? "", true, 5, 60); return 0; });
                    return "ok";
            }
            throw new Exception($"unknown cmd {cmd}");
        }

        static string StripTags(string html) => System.Net.WebUtility.HtmlDecode(System.Text.RegularExpressions.Regex.Replace(html, "<[^>]+>", ""));

        /// <summary>CF_HTML clipboard envelope.</summary>
        static string HtmlClipboard(string fragment)
        {
            const string header = "Version:0.9\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
            string pre = "<html><body><!--StartFragment-->", post = "<!--EndFragment--></body></html>";
            int hl = string.Format(header, 0, 0, 0, 0).Length;
            int startHtml = hl, startFrag = startHtml + Encoding.UTF8.GetByteCount(pre);
            int endFrag = startFrag + Encoding.UTF8.GetByteCount(fragment), endHtml = endFrag + Encoding.UTF8.GetByteCount(post);
            return string.Format(header, startHtml, endHtml, startFrag, endFrag) + pre + fragment + post;
        }
    }
}
