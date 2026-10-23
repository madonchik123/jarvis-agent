using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;

namespace JarvisNative
{
    /// <summary>Installed apps (the Start menu "AppsFolder") and launching by name, alias, path, URL or AUMID.</summary>
    internal static class Apps
    {
        public class App
        {
            public string name;
            public string id; // AUMID (store apps) or path
        }

        static List<App> cache;
        static DateTime cachedAt;

        /// <summary>Everything in the Start menu (classic + Store apps). Must run on an STA thread.</summary>
        public static List<App> Installed()
        {
            if (cache != null && (DateTime.UtcNow - cachedAt).TotalMinutes < 10) return cache;
            var list = new List<App>();
            try
            {
                var t = Type.GetTypeFromProgID("Shell.Application");
                dynamic shell = Activator.CreateInstance(t);
                dynamic folder = shell.NameSpace("shell:::{4234d49b-0245-4df3-b780-3893943456e1}");
                foreach (dynamic item in folder.Items())
                {
                    string name = item.Name;
                    string path = item.Path;
                    if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(path)) list.Add(new App { name = name, id = path });
                }
            }
            catch { }
            cache = list.GroupBy(a => a.name.ToLowerInvariant()).Select(g => g.First()).OrderBy(a => a.name).ToList();
            cachedAt = DateTime.UtcNow;
            return cache;
        }

        static readonly Dictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["calculator"] = "calc", ["калькулятор"] = "calc", ["notepad"] = "notepad", ["блокнот"] = "notepad", ["paint"] = "mspaint", ["пейнт"] = "mspaint",
            ["explorer"] = "explorer", ["проводник"] = "explorer", ["file explorer"] = "explorer", ["cmd"] = "cmd", ["command prompt"] = "cmd", ["терминал"] = "wt",
            ["terminal"] = "wt", ["powershell"] = "powershell", ["task manager"] = "taskmgr", ["диспетчер задач"] = "taskmgr", ["settings"] = "ms-settings:",
            ["параметры"] = "ms-settings:", ["настройки"] = "ms-settings:", ["control panel"] = "control", ["панель управления"] = "control", ["snipping tool"] = "snippingtool",
            ["ножницы"] = "snippingtool", ["word"] = "winword", ["excel"] = "excel", ["powerpoint"] = "powerpnt", ["chrome"] = "chrome", ["google chrome"] = "chrome",
            ["хром"] = "chrome", ["firefox"] = "firefox", ["edge"] = "msedge", ["браузер"] = "msedge", ["vivaldi"] = "vivaldi", ["vscode"] = "code",
            ["visual studio code"] = "code", ["discord"] = "discord", ["telegram"] = "telegram", ["steam"] = "steam", ["spotify"] = "spotify"
        };

        static bool Start(string target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                return true;
            }
            catch { return false; }
        }

        /// <summary>Launch and wait for its window; returns how it was started and the window (if one appeared).</summary>
        public static Dictionary<string, object> Launch(string name, int waitMs, Func<List<App>> installed)
        {
            var before = new HashSet<long>(Windows.List().Select(w => w.hwnd));
            string how;
            var q = name.Trim().ToLowerInvariant();
            bool isTarget = Regex.IsMatch(name, @"^(https?://|[a-zA-Z]:\\|\\\\|shell:|ms-[a-z\-]+:)") || Regex.IsMatch(name, @"\.(exe|lnk|txt|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip)$", RegexOptions.IgnoreCase) || name.Contains("!");
            if (isTarget)
            {
                var target = name.Contains("!") && !name.Contains("\\") && !name.Contains("://") ? "shell:AppsFolder\\" + name : name;
                if (!Start(target)) throw new Exception($"could not open '{name}'");
                how = "direct";
            }
            else
            {
                var apps = installed();
                var hit = apps.FirstOrDefault(a => a.name.ToLowerInvariant() == q) ?? apps.FirstOrDefault(a => a.name.ToLowerInvariant().StartsWith(q)) ?? apps.FirstOrDefault(a => a.name.ToLowerInvariant().Contains(q));
                if (hit != null && Start("shell:AppsFolder\\" + hit.id)) how = "start-menu:" + hit.name;
                else if (Aliases.TryGetValue(q, out var alias) && Start(alias)) how = "alias:" + alias;
                else if (Start(name)) how = "path";
                else
                {
                    // fuzzy: closest Start-menu name (localised names / typos)
                    App best = null;
                    int bestScore = 0;
                    foreach (var a in apps)
                    {
                        var n = a.name.ToLowerInvariant();
                        int common = q.Split(' ').Where(tok => tok.Length > 2 && n.Contains(tok)).Sum(tok => tok.Length);
                        if (common > bestScore) { bestScore = common; best = a; }
                    }
                    if (best != null && bestScore >= 4 && Start("shell:AppsFolder\\" + best.id)) how = "fuzzy:" + best.name;
                    else throw new Exception($"could not find an app named '{name}' (not in the Start menu, PATH or known aliases)");
                }
            }
            if (how == "direct" && Regex.IsMatch(name, "^https?://"))
            {
                Thread.Sleep(Math.Min(waitMs, 4000));
                return new Dictionary<string, object> { ["how"] = how, ["window"] = Windows.Foreground().ToJson() };
            }
            var tok2 = Regex.Replace(Regex.Replace(name, @"^.*[\\/]", ""), @"\.\w+$", "").ToLowerInvariant();
            var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
            WinInfo found = null;
            while (DateTime.UtcNow < deadline && found == null)
            {
                Thread.Sleep(250);
                foreach (var w in Windows.List())
                {
                    if (w.process == "electron" || w.process.StartsWith("Jarvis")) continue;
                    bool isNew = !before.Contains(w.hwnd);
                    bool named = w.title.ToLowerInvariant().Contains(tok2) || w.process.ToLowerInvariant().Contains(tok2);
                    if (isNew || named) { found = w; break; }
                }
            }
            if (found != null) Windows.Activate((IntPtr)found.hwnd);
            return new Dictionary<string, object> { ["how"] = how, ["window"] = found?.ToJson() };
        }
    }
}
