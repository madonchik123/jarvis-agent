using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace JarvisNative
{
    /// <summary>UI Automation: indexed accessibility trees per window (Codex-style), element actions, and the flat element scan used by the OCR map.</summary>
    internal static class Uia
    {
        static AutomationFocusChangedEventHandler focusHandler;

        /// <summary>Chromium/Electron only build their accessibility tree while some UIA client listens for events.</summary>
        public static void WarmUp()
        {
            try
            {
                focusHandler = (s, e) => { };
                Automation.AddAutomationFocusChangedEventHandler(focusHandler);
            }
            catch { }
        }

        static readonly HashSet<string> Interactive = new HashSet<string> { "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton", "Slider", "Spinner", "Tab", "TabItem", "TreeItem", "SplitButton", "Document", "DataItem", "MenuBarItem" };

        static readonly Dictionary<string, string> RoleNames = new Dictionary<string, string>
        {
            ["Edit"] = "text field", ["ComboBox"] = "combo box", ["CheckBox"] = "check box", ["RadioButton"] = "radio button", ["ListItem"] = "list item",
            ["MenuItem"] = "menu item", ["MenuBar"] = "menu bar", ["TabItem"] = "tab", ["Tab"] = "tab list", ["TreeItem"] = "tree item",
            ["SplitButton"] = "split button", ["DataItem"] = "data item", ["DataGrid"] = "grid", ["ToolBar"] = "toolbar", ["TitleBar"] = "title bar",
            ["ScrollBar"] = "scroll bar", ["StatusBar"] = "status bar", ["ProgressBar"] = "progress bar", ["Hyperlink"] = "link", ["Pane"] = "pane",
            ["Group"] = "group", ["Text"] = "text", ["Image"] = "image", ["Window"] = "window", ["Document"] = "document", ["Custom"] = "custom"
        };

        static string Role(ControlType t)
        {
            var n = t.ProgrammaticName.Replace("ControlType.", "");
            return RoleNames.TryGetValue(n, out var r) ? r : n.ToLowerInvariant();
        }

        static string Clip(string s, int n) => string.IsNullOrEmpty(s) ? "" : (s.Length > n ? s.Substring(0, n) + "…" : s);
        static string OneLine(string s) => (s ?? "").Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Trim();

        // ------------------------------------------------------------------------------------------ indexed tree (window state)
        class Indexed
        {
            public AutomationElement el;
            public Rect rect;
        }

        // latest tree of each window: element_index -> element
        static readonly Dictionary<long, List<Indexed>> trees = new Dictionary<long, List<Indexed>>();

        static CacheRequest TreeCache()
        {
            var c = new CacheRequest { TreeScope = TreeScope.Element | TreeScope.Children, AutomationElementMode = AutomationElementMode.Full, TreeFilter = Automation.ControlViewCondition };
            foreach (var p in new[] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty,
                AutomationElement.IsEnabledProperty, AutomationElement.AutomationIdProperty, AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsKeyboardFocusableProperty,
                AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
                AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
                AutomationElement.IsScrollItemPatternAvailableProperty, AutomationElement.IsTextPatternAvailableProperty, AutomationElement.IsWindowPatternAvailableProperty,
                ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
                SelectionItemPattern.IsSelectedProperty })
                c.Add(p);
            return c;
        }

        static object Cached(AutomationElement e, AutomationProperty p)
        {
            try { return e.GetCachedPropertyValue(p, true); } catch { return null; }
        }

        static bool Flag(AutomationElement e, AutomationProperty p) => Cached(e, p) is bool b && b;

        static List<string> SecondaryActions(AutomationElement e)
        {
            var a = new List<string>();
            if (Flag(e, AutomationElement.IsInvokePatternAvailableProperty)) a.Add("Invoke");
            if (Flag(e, AutomationElement.IsTogglePatternAvailableProperty)) a.Add("Toggle");
            if (Flag(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))
            {
                var st = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty);
                if (st is ExpandCollapseState s && s == ExpandCollapseState.Expanded) a.Add("Collapse"); else a.Add("Expand");
            }
            if (Flag(e, AutomationElement.IsSelectionItemPatternAvailableProperty)) a.Add("Select");
            if (Flag(e, AutomationElement.IsValuePatternAvailableProperty) && !(Cached(e, ValuePattern.IsReadOnlyProperty) is bool ro && ro)) a.Add("SetValue");
            if (Flag(e, AutomationElement.IsScrollPatternAvailableProperty)) a.AddRange(new[] { "Scroll Up", "Scroll Down" });
            if (Flag(e, AutomationElement.IsScrollItemPatternAvailableProperty)) a.Add("ScrollIntoView");
            if (Flag(e, AutomationElement.IsWindowPatternAvailableProperty)) a.Add("Raise");
            return a;
        }

        public class TreeResult
        {
            public string tree;
            public int count;
            public string focused;
            public string selectedText;
            public string documentText;
            public bool truncated;
        }

        /// <summary>
        /// The window's accessibility tree as indented text: "12 button Save (Invoke) [x,y w×h]" with window-relative coordinates
        /// in screenshot pixels (scale = screenshot / physical). Indexes stay valid until the next call for this window.
        /// </summary>
        public static TreeResult WindowTree(IntPtr hwnd, int maxNodes, int textLimit, double scale)
        {
            var bounds = Win32.Bounds(hwnd);
            var root = AutomationElement.FromHandle(hwnd);
            var cache = TreeCache();
            var list = new List<Indexed>();
            var sb = new StringBuilder();
            bool truncated = false;
            AutomationElement document = null;
            var deadline = DateTime.UtcNow.AddSeconds(8);

            void Walk(AutomationElement parent, int depth, int indent)
            {
                if (list.Count >= maxNodes || DateTime.UtcNow > deadline) { truncated = true; return; }
                AutomationElement withKids;
                try
                {
                    using (cache.Activate()) withKids = parent.GetUpdatedCache(cache);
                }
                catch { return; }
                AutomationElementCollection kids;
                try { kids = withKids.CachedChildren; } catch { return; }
                foreach (AutomationElement e in kids)
                {
                    if (list.Count >= maxNodes || DateTime.UtcNow > deadline) { truncated = true; return; }
                    var type = Cached(e, AutomationElement.ControlTypeProperty) as ControlType ?? ControlType.Custom;
                    var tn = type.ProgrammaticName.Replace("ControlType.", "");
                    var rect = Cached(e, AutomationElement.BoundingRectangleProperty) is Rect r ? r : Rect.Empty;
                    bool off = Flag(e, AutomationElement.IsOffscreenProperty);
                    bool visible = !off && !rect.IsEmpty && rect.Width > 1 && rect.Height > 1 && !double.IsInfinity(rect.X);
                    string name = OneLine(Cached(e, AutomationElement.NameProperty) as string);
                    string value = Flag(e, AutomationElement.IsValuePatternAvailableProperty) ? OneLine(Cached(e, ValuePattern.ValueProperty) as string) : "";
                    var actions = SecondaryActions(e);
                    bool interesting = name.Length > 0 || value.Length > 0 || Interactive.Contains(tn) || actions.Count > 0;
                    if (type == ControlType.Document && document == null) document = e;
                    int childIndent = indent;
                    if (visible && interesting)
                    {
                        int idx = list.Count;
                        list.Add(new Indexed { el = e, rect = rect });
                        var line = new StringBuilder();
                        line.Append(' ', indent * 2).Append(idx).Append(' ').Append(Role(type));
                        if (name.Length > 0) line.Append(' ').Append(Clip(name, textLimit));
                        if (value.Length > 0 && value != name) line.Append(" = \"").Append(Clip(value, textLimit)).Append('"');
                        var states = new List<string>();
                        if (!Flag(e, AutomationElement.IsEnabledProperty)) states.Add("disabled");
                        if (Flag(e, AutomationElement.HasKeyboardFocusProperty)) states.Add("focused");
                        if (Cached(e, TogglePattern.ToggleStateProperty) is ToggleState ts && ts == ToggleState.On) states.Add("checked");
                        if (Flag(e, SelectionItemPattern.IsSelectedProperty)) states.Add("selected");
                        if (states.Count > 0) line.Append(" (").Append(string.Join(", ", states)).Append(')');
                        if (actions.Count > 0) line.Append(" Secondary Actions: ").Append(string.Join(", ", actions));
                        int x = (int)Math.Round((rect.X - bounds.L) * scale), y = (int)Math.Round((rect.Y - bounds.T) * scale);
                        line.Append(" Frame: {x: ").Append(x).Append(", y: ").Append(y).Append(", width: ").Append((int)Math.Round(rect.Width * scale)).Append(", height: ").Append((int)Math.Round(rect.Height * scale)).Append('}');
                        sb.AppendLine(line.ToString());
                        childIndent = indent + 1;
                    }
                    // offscreen containers can still hold visible children (scrolled lists): descend unless tiny / hidden
                    if (depth < 40 && (visible || rect.IsEmpty || off)) Walk(e, depth + 1, childIndent);
                }
            }

            Walk(root, 0, 0);
            lock (trees) trees[(long)hwnd] = list;

            var res = new TreeResult { tree = sb.ToString(), count = list.Count, truncated = truncated };
            try
            {
                var f = AutomationElement.FocusedElement;
                if (f != null)
                {
                    var c = f.Current;
                    res.focused = $"{Role(c.ControlType)} {Clip(OneLine(c.Name), 120)}".Trim();
                    if (f.TryGetCurrentPattern(TextPattern.Pattern, out object tp))
                    {
                        var sel = ((TextPattern)tp).GetSelection();
                        if (sel.Length > 0) res.selectedText = Clip(sel[0].GetText(2000), 2000);
                    }
                }
            }
            catch { }
            try
            {
                if (document != null && document.TryGetCurrentPattern(TextPattern.Pattern, out object dp))
                    res.documentText = Clip(((TextPattern)dp).DocumentRange.GetText(8000), 8000);
            }
            catch { }
            return res;
        }

        static Indexed Element(long hwnd, int index)
        {
            lock (trees)
            {
                if (!trees.TryGetValue(hwnd, out var l)) throw new Exception("no window state yet: call get_window_state for this window first");
                if (index < 0 || index >= l.Count) throw new Exception($"element_index {index} is not in the latest window state (0..{l.Count - 1}); refresh the state");
                return l[index];
            }
        }

        /// <summary>Screen point of an indexed element (its live position, falling back to the cached one).</summary>
        public static (int x, int y, bool visible) ElementPoint(long hwnd, int index)
        {
            var it = Element(hwnd, index);
            Rect r = it.rect;
            bool off = false;
            try
            {
                r = it.el.Current.BoundingRectangle;
                off = it.el.Current.IsOffscreen;
            }
            catch { }
            if (r.IsEmpty || double.IsInfinity(r.X)) return (0, 0, false);
            // the centre of the element (UIA "clickable points" of XAML apps can land on a neighbouring control)
            return ((int)Math.Round(r.X + r.Width / 2), (int)Math.Round(r.Y + r.Height / 2), !off);
        }

        public static string Invoke(long hwnd, int index)
        {
            var el = Element(hwnd, index).el;
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out object p)) { ((InvokePattern)p).Invoke(); return "invoke"; }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggle"; }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "select"; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expand"; }
            throw new Exception("element has no invoke-like action");
        }

        public static void Focus(long hwnd, int index)
        {
            try { Element(hwnd, index).el.SetFocus(); } catch { }
        }

        public static string SetValue(long hwnd, int index, string value)
        {
            var el = Element(hwnd, index).el;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out object p) && !((ValuePattern)p).Current.IsReadOnly)
            {
                ((ValuePattern)p).SetValue(value);
                return "value";
            }
            if (el.TryGetCurrentPattern(RangeValuePattern.Pattern, out p) && double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double d))
            {
                ((RangeValuePattern)p).SetValue(d);
                return "range";
            }
            return ""; // caller falls back to focus + select-all + typing
        }

        public static string Secondary(long hwnd, int index, string action)
        {
            var el = Element(hwnd, index).el;
            var a = (action ?? "").Trim().ToLowerInvariant();
            object p;
            switch (a)
            {
                case "invoke": case "press": case "click": return Invoke(hwnd, index);
                case "toggle": if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggle"; } break;
                case "expand": if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expand"; } break;
                case "collapse": if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Collapse(); return "collapse"; } break;
                case "select": if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "select"; } break;
                case "scrollintoview": case "scroll into view": if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { ((ScrollItemPattern)p).ScrollIntoView(); return "scrollintoview"; } break;
                case "focus": el.SetFocus(); return "focus";
                case "raise": if (el.TryGetCurrentPattern(WindowPattern.Pattern, out p)) { ((WindowPattern)p).SetWindowVisualState(WindowVisualState.Normal); return "raise"; } break;
                case "scroll up": case "scroll down": case "scroll left": case "scroll right":
                    if (el.TryGetCurrentPattern(ScrollPattern.Pattern, out p))
                    {
                        var sp = (ScrollPattern)p;
                        if (a.EndsWith("up")) sp.ScrollVertical(ScrollAmount.LargeDecrement);
                        else if (a.EndsWith("down")) sp.ScrollVertical(ScrollAmount.LargeIncrement);
                        else if (a.EndsWith("left")) sp.ScrollHorizontal(ScrollAmount.LargeDecrement);
                        else sp.ScrollHorizontal(ScrollAmount.LargeIncrement);
                        return a;
                    }
                    break;
            }
            throw new Exception($"element {index} does not support '{action}'");
        }

        // ------------------------------------------------------------------------------------------ flat scan (OCR map / click_text)
        static readonly Dictionary<string, AutomationElement> flatCache = new Dictionary<string, AutomationElement>();
        static int flatSeq;

        public static Dictionary<string, object> FlatScan(IntPtr h0, int max, string query)
        {
            var outp = new List<object>();
            if (h0 == IntPtr.Zero) return new Dictionary<string, object> { ["window"] = "", ["cls"] = "", ["elements"] = outp };
            lock (flatCache) { flatCache.Clear(); flatSeq = 0; }
            var root = AutomationElement.FromHandle(h0);
            string cls = "";
            try { cls = root.Current.ClassName; } catch { }
            var cache = TreeCache();
            var q = (query ?? "").ToLowerInvariant();
            var deadline = DateTime.UtcNow.AddSeconds(5);
            var queue = new Queue<(AutomationElement el, int depth)>();
            queue.Enqueue((root, 0));
            while (queue.Count > 0 && outp.Count < max && DateTime.UtcNow < deadline)
            {
                var (el, depth) = queue.Dequeue();
                AutomationElement withKids;
                try { using (cache.Activate()) withKids = el.GetUpdatedCache(cache); } catch { continue; }
                if (depth > 0)
                {
                    var type = (Cached(withKids, AutomationElement.ControlTypeProperty) as ControlType ?? ControlType.Custom).ProgrammaticName.Replace("ControlType.", "");
                    var r = Cached(withKids, AutomationElement.BoundingRectangleProperty) is Rect rr ? rr : Rect.Empty;
                    var name = OneLine(Cached(withKids, AutomationElement.NameProperty) as string);
                    var auto = Cached(withKids, AutomationElement.AutomationIdProperty) as string ?? "";
                    bool visible = !Flag(withKids, AutomationElement.IsOffscreenProperty) && !r.IsEmpty && r.Width > 2 && r.Height > 2 && !double.IsInfinity(r.X);
                    bool match = q.Length == 0 || name.ToLowerInvariant().Contains(q) || auto.ToLowerInvariant().Contains(q);
                    if (visible && match && (name.Length > 0 || Interactive.Contains(type)))
                    {
                        string id;
                        lock (flatCache) { id = "e" + (++flatSeq); flatCache[id] = withKids; }
                        string val = "";
                        if (type == "Edit" || type == "ComboBox") val = OneLine(Cached(withKids, ValuePattern.ValueProperty) as string);
                        outp.Add(new Dictionary<string, object>
                        {
                            ["id"] = id, ["type"] = type, ["name"] = Clip(name, 140), ["auto"] = auto, ["x"] = (int)r.X, ["y"] = (int)r.Y, ["w"] = (int)r.Width, ["h"] = (int)r.Height,
                            ["enabled"] = Flag(withKids, AutomationElement.IsEnabledProperty), ["value"] = Clip(val, 80), ["depth"] = depth
                        });
                    }
                }
                if (depth < 14)
                    try { foreach (AutomationElement c in withKids.CachedChildren) queue.Enqueue((c, depth + 1)); } catch { }
            }
            // Chromium builds its tree lazily after the first UIA request: wait once and retry
            if (outp.Count < 8 && cls.StartsWith("Chrome_WidgetWin") && query != "\u0001retry")
            {
                Thread.Sleep(1600);
                var again = FlatScan(h0, max, string.IsNullOrEmpty(query) ? "\u0001retry" : query);
                return again;
            }
            string title = "";
            try { title = root.Current.Name; } catch { }
            return new Dictionary<string, object> { ["window"] = title, ["cls"] = cls, ["elements"] = outp, ["errors"] = 0, ["firstError"] = "" };
        }

        public static Dictionary<string, object> FlatInvoke(string id, string text)
        {
            AutomationElement el;
            lock (flatCache) if (!flatCache.TryGetValue(id, out el)) throw new Exception("unknown element id (scan again)");
            object p;
            if (text != null)
            {
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { ((ValuePattern)p).SetValue(text); return new Dictionary<string, object> { ["done"] = "value" }; }
                throw new Exception("element does not accept text");
            }
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return new Dictionary<string, object> { ["done"] = "invoke" }; }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return new Dictionary<string, object> { ["done"] = "toggle" }; }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return new Dictionary<string, object> { ["done"] = "select" }; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return new Dictionary<string, object> { ["done"] = "expand" }; }
            throw new Exception("no-pattern");
        }
    }
}
