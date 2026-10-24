using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace JarvisInstaller
{
    /// <summary>What latest.yml (published by electron-builder with every release) says about the current version.</summary>
    internal sealed class Release
    {
        public string Version = "";
        public string File = "";
        public string Sha512 = "";
        public long Size;
        public string Url => $"{Setup.Repo}/releases/download/v{Version}/{Uri.EscapeDataString(File)}";
    }

    /// <summary>Download → verify → silent install of the regular Jarvis package (which keeps auto-update working).</summary>
    internal static class Setup
    {
        public const string Repo = "https://github.com/madonchik123/jarvis-agent";
        public const long InstalledBytes = 1_080_000_000; // ~1 GB unpacked (app + agent + engine), for the progress bar

        static Setup()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // TLS 1.2 + 1.3
            // the system proxy (many users in Russia need one to reach GitHub)
            WebRequest.DefaultWebProxy = WebRequest.GetSystemWebProxy();
            WebRequest.DefaultWebProxy.Credentials = CredentialCache.DefaultCredentials;
        }

        static HttpWebRequest Req(string url)
        {
            var r = (HttpWebRequest)WebRequest.Create(url);
            r.UserAgent = "Jarvis-Installer/1.0";
            r.AllowAutoRedirect = true;
            r.Timeout = 30000;
            r.ReadWriteTimeout = 60000;
            return r;
        }

        public static Release Latest()
        {
            string yml;
            using (var resp = Req($"{Repo}/releases/latest/download/latest.yml").GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream()))
                yml = sr.ReadToEnd();
            var rel = new Release();
            foreach (var raw in yml.Split('\n'))
            {
                var line = raw.Trim();
                string Val() => line.Substring(line.IndexOf(':') + 1).Trim().Trim('\'', '"');
                if (line.StartsWith("version:")) rel.Version = Val();
                else if (line.StartsWith("path:")) rel.File = Val();
                else if (line.StartsWith("sha512:")) rel.Sha512 = Val();
                else if (line.StartsWith("size:") && rel.Size == 0) long.TryParse(Val(), out rel.Size);
            }
            if (rel.Version == "" || rel.File == "") throw new Exception("latest.yml has no version");
            return rel;
        }

        /// <summary>Where Jarvis already lives (so an update goes to the same place), else the per-user default.</summary>
        public static string InstallDir()
        {
            try
            {
                using (var un = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                    foreach (var name in un?.GetSubKeyNames() ?? new string[0])
                        using (var k = un.OpenSubKey(name))
                        {
                            var dn = k?.GetValue("DisplayName") as string ?? "";
                            var loc = k?.GetValue("InstallLocation") as string ?? "";
                            if (dn.StartsWith("Jarvis") && loc != "" && Directory.Exists(loc)) return loc;
                        }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Jarvis");
        }

        public static async Task<string> Download(Release rel, Action<long, long, double> progress, CancellationToken ct)
        {
            var dest = Path.Combine(Path.GetTempPath(), "Jarvis-Setup", rel.File);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            if (File.Exists(dest) && new FileInfo(dest).Length == rel.Size && Verify(dest, rel.Sha512)) return dest; // finished earlier
            var part = dest + ".part";
            using (var resp = await Req(rel.Url).GetResponseAsync())
            using (var src = resp.GetResponseStream())
            using (var dst = File.Create(part))
            {
                long total = resp.ContentLength > 0 ? resp.ContentLength : rel.Size;
                var buf = new byte[1 << 17];
                long got = 0;
                var sw = Stopwatch.StartNew();
                long lastBytes = 0;
                double lastT = 0, speed = 0;
                int n;
                while ((n = await src.ReadAsync(buf, 0, buf.Length, ct)) > 0)
                {
                    await dst.WriteAsync(buf, 0, n, ct);
                    got += n;
                    var t = sw.Elapsed.TotalSeconds;
                    if (t - lastT >= 0.4)
                    {
                        var inst = (got - lastBytes) / (t - lastT);
                        speed = speed == 0 ? inst : speed * 0.7 + inst * 0.3;
                        lastBytes = got;
                        lastT = t;
                        progress(got, total, speed);
                    }
                }
                progress(got, total, speed);
            }
            if (!Verify(part, rel.Sha512))
            {
                File.Delete(part);
                throw new Exception("checksum");
            }
            if (File.Exists(dest)) File.Delete(dest);
            File.Move(part, dest);
            return dest;
        }

        public static bool Verify(string file, string sha512b64)
        {
            if (string.IsNullOrEmpty(sha512b64)) return true;
            using (var s = File.OpenRead(file))
            using (var h = SHA512.Create())
                return Convert.ToBase64String(h.ComputeHash(s)) == sha512b64;
        }

        public static Process[] Running(string dir) =>
            Process.GetProcessesByName("Jarvis").Where(p =>
            {
                try { return p.MainModule.FileName.StartsWith(dir, StringComparison.OrdinalIgnoreCase); } catch { return true; }
            }).ToArray();

        /// <summary>Runs the package silently; reports install progress from the bytes appearing in the target folder.</summary>
        public static async Task<int> Install(string setupExe, string dir, Action<double> progress)
        {
            var p = Process.Start(new ProcessStartInfo(setupExe, $"/S /currentuser /D={dir}") { UseShellExecute = false });
            long min = long.MaxValue;
            while (!p.HasExited)
            {
                var size = DirSize(dir);
                min = Math.Min(min, size);
                progress(Math.Min(0.97, (size - min) / (double)InstalledBytes));
                await Task.Delay(400);
            }
            progress(1);
            return p.ExitCode;
        }

        static long DirSize(string dir)
        {
            try
            {
                if (!Directory.Exists(dir)) return 0;
                return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => { try { return f.Length; } catch { return 0L; } });
            }
            catch { return 0; }
        }
    }
}
