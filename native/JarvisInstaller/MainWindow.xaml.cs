using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace JarvisInstaller
{
    public partial class MainWindow : Window
    {
        readonly bool ru;
        readonly bool demo; // --demo: the full UI with simulated progress, nothing is downloaded or installed (screenshots / videos)
        readonly string payload; // --payload <Jarvis-Setup.exe>: install from a local file instead of downloading
        string dir;
        Release rel;
        readonly CancellationTokenSource cts = new CancellationTokenSource();
        readonly DispatcherTimer tipTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4.5) };
        int tipIndex;
        bool busy;

        string L(string r, string e) => ru ? r : e;

        public MainWindow()
        {
            InitializeComponent();
            // a Border's CornerRadius doesn't clip its content: clip it ourselves so the glow blobs stay inside the rounded corners
            Inner.SizeChanged += (_, e) => Inner.Clip = new RectangleGeometry(new Rect(e.NewSize), 21, 21);
            var args = Environment.GetCommandLineArgs().Skip(1).ToList();
            demo = args.Contains("--demo");
            var pi = args.IndexOf("--payload");
            payload = pi >= 0 && pi + 1 < args.Count ? args[pi + 1] : null;
            var li = args.IndexOf("--lang");
            ru = li >= 0 && li + 1 < args.Count ? args[li + 1] == "ru" : CultureInfo.CurrentUICulture.TwoLetterISOLanguageName is "ru" or "uk" or "be" or "kk";
            var di = args.IndexOf("--dir");
            dir = di >= 0 && di + 1 < args.Count ? args[di + 1] : Setup.InstallDir();
            Localize();
            if (args.Contains("--no-launch")) LaunchAfter.IsChecked = false;
            if (args.Contains("--no-desktop")) Desktop.IsChecked = false;
            Animate(false);
            Loaded += async (_, __) =>
            {
                await LoadRelease();
                // --auto: press Install by itself (unattended installs, screen recordings)
                if (args.Contains("--auto")) { await Task.Delay(demo ? 2500 : 300); Install(null, null); }
            };
            tipTimer.Tick += (_, __) => NextTip();
        }

        void Localize()
        {
            TitleSub.Text = "·  " + L("Установка", "Setup");
            OrbLabel.Text = L("ЖДУ КОМАНДЫ", "STANDING BY");
            Hello.Text = L("Голосовой ИИ-агент для вашего ПК", "A voice AI agent for your PC");
            HelloSub.Text = L("Просто говорите — Джарвис откроет программы, напечатает, найдёт в интернете и сделает документ.", "Just talk — Jarvis opens apps, types, searches the web and makes documents for you.");
            Features.Children.Clear();
            foreach (var f in new[]
            {
                L("Управляет любыми программами и окнами", "Controls any app and window"),
                L("Речь распознаётся прямо на вашем ПК", "Speech is recognised on your PC"),
                L("Бесплатно — без ключей и регистрации", "Free — no keys, no sign-up")
            })
                Features.Children.Add(Feature(f));
            PathLabel.Text = L("Папка установки", "Install location");
            PathText.Text = dir;
            ChangeBtn.Content = L("Изменить", "Change");
            Desktop.Content = L("Ярлык на рабочем столе", "Desktop shortcut");
            LaunchAfter.Content = L("Запустить Jarvis после установки", "Launch Jarvis when done");
            InstallBtn.Content = L("Установить", "Install");
            Meta.Text = L("Проверяю последнюю версию…", "Checking the latest version…");
            ProgTitle.Text = L("Устанавливаю Jarvis…", "Installing Jarvis…");
            DoneTitle.Text = L("Готово, сэр.", "All set, sir.");
            DoneText.Text = L("Jarvis установлен. При первом запуске он сам докачает модели речи (~500 МБ) — пользоваться можно сразу.", "Jarvis is installed. On first launch it downloads its speech models (~500 MB) by itself — you can use it right away.");
            DoneHint.Text = L("Скажите «Джарвис» — и просто говорите, что нужно. Например: «Какой сейчас курс доллара?»", "Say “Jarvis” — then just say what you need. For example: “What's the dollar rate today?”");
            CloseBtn.Content = L("Закрыть", "Close");
            LaunchBtn.Content = L("Запустить Jarvis", "Launch Jarvis");
            ErrTitle.Text = L("Не получилось", "Something went wrong");
            ManualBtn.Content = L("Скачать вручную", "Download manually");
            RetryBtn.Content = L("Повторить", "Retry");
        }

        UIElement Feature(string text)
        {
            var sp = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 11) };
            var dot = new Border { Width = 22, Height = 22, CornerRadius = new CornerRadius(11), Background = new SolidColorBrush(Color.FromArgb(0x22, 0x38, 0xD6, 0xFF)) };
            dot.Child = new TextBlock { Text = "", FontFamily = new FontFamily("Segoe MDL2 Assets"), FontSize = 11, Foreground = (Brush)FindResource("Accent"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            sp.Children.Add(dot);
            sp.Children.Add(new TextBlock { Text = text, Margin = new Thickness(12, 0, 0, 0), Foreground = (Brush)FindResource("Text"), FontSize = 14, VerticalAlignment = VerticalAlignment.Center });
            return sp;
        }

        /// <summary>orb: rotating rings + breathing core; faster while working</summary>
        void Animate(bool working)
        {
            var speed = working ? 3.0 : 1.0;
            Rot1.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(14 / speed)) { RepeatBehavior = RepeatBehavior.Forever });
            Rot2.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(360, 0, TimeSpan.FromSeconds(22 / speed)) { RepeatBehavior = RepeatBehavior.Forever });
            var pulse = new DoubleAnimation(1, working ? 1.14 : 1.07, TimeSpan.FromSeconds(working ? 0.7 : 1.6)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase() };
            Pulse.BeginAnimation(ScaleTransform.ScaleXProperty, pulse);
            Pulse.BeginAnimation(ScaleTransform.ScaleYProperty, pulse);
            OrbLabel.Text = working ? L("РАБОТАЮ", "WORKING") : L("ЖДУ КОМАНДЫ", "STANDING BY");
        }

        async Task LoadRelease()
        {
            if (demo)
            {
                rel = new Release { Version = "1.2.2", File = "Jarvis-Setup-1.2.2.exe", Size = 300_336_104 };
            }
            else if (payload != null && File.Exists(payload))
            {
                rel = new Release { Version = "local", File = Path.GetFileName(payload), Size = new FileInfo(payload).Length };
            }
            else
            {
                try
                {
                    rel = await Task.Run(() => Setup.Latest());
                }
                catch
                {
                    Meta.Text = L("Нет связи с GitHub — проверьте интернет / VPN", "Can't reach GitHub — check the connection / VPN");
                    return;
                }
            }
            Meta.Text = L($"Версия {rel.Version}  ·  {rel.Size / 1048576} МБ", $"Version {rel.Version}  ·  {rel.Size / 1048576} MB");
        }

        void Show(Grid page)
        {
            foreach (var p in new[] { PageWelcome, PageProgress, PageDone, PageError }) p.Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;
            page.Opacity = 0;
            var tt = new TranslateTransform(0, 14);
            page.RenderTransform = tt;
            page.BeginAnimation(OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(320)));
            tt.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(320)) { EasingFunction = new CubicEase() });
        }

        void SetProgress(double f, string status, string detail)
        {
            f = Math.Max(0, Math.Min(1, f));
            Fill.BeginAnimation(WidthProperty, new DoubleAnimation(Track.ActualWidth * f, TimeSpan.FromMilliseconds(380)));
            ProgPct.Text = $"{Math.Round(f * 100)}%";
            if (status != null) ProgStatus.Text = status;
            if (detail != null) ProgDetail.Text = detail;
        }

        void NextTip()
        {
            var tips = ru
                ? new[] { "Скажите «Джарвис» — и он слушает. Горячая клавиша: Ctrl+Alt+J.", "Можно говорить по-русски и по-английски, даже вперемешку.", "«Сделай презентацию про…» — и через минуту готовый PPTX.", "Ctrl+Alt+K мгновенно останавливает управление компьютером.", "Бесплатные модели работают сразу, без ключей и регистрации." }
                : new[] { "Say “Jarvis” and it listens. Hotkey: Ctrl+Alt+J.", "Talk in English or Russian — even mixed.", "“Make a presentation about…” — a finished PPTX in a minute.", "Ctrl+Alt+K instantly stops computer control.", "Free models work out of the box — no keys, no sign-up." };
            Tip.Text = tips[tipIndex++ % tips.Length];
            // long tips scroll inside their box (hold → scroll to the end → hold → back) instead of being cut off
            TipShift.BeginAnimation(TranslateTransform.XProperty, null);
            TipShift.X = 0;
            Tip.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var overflow = Tip.DesiredSize.Width - TipView.ActualWidth;
            var shown = 4.5;
            if (overflow > 4 && TipView.ActualWidth > 0)
            {
                var scroll = Math.Max(1.2, overflow / 45.0); // ~45 px/s
                var k = new DoubleAnimationUsingKeyFrames();
                k.KeyFrames.Add(new LinearDoubleKeyFrame(0, KeyTime.FromTimeSpan(TimeSpan.FromSeconds(1.4))));
                k.KeyFrames.Add(new EasingDoubleKeyFrame(-overflow, KeyTime.FromTimeSpan(TimeSpan.FromSeconds(1.4 + scroll)), new SineEase { EasingMode = EasingMode.EaseInOut }));
                k.KeyFrames.Add(new LinearDoubleKeyFrame(-overflow, KeyTime.FromTimeSpan(TimeSpan.FromSeconds(2.8 + scroll))));
                TipShift.BeginAnimation(TranslateTransform.XProperty, k);
                shown = 3.2 + scroll;
            }
            tipTimer.Interval = TimeSpan.FromSeconds(shown);
        }

        async void Install(object sender, RoutedEventArgs e)
        {
            if (busy) return;
            busy = true;
            Show(PageProgress);
            Animate(true);
            // after layout: the tip box has no width until the page has been measured
            _ = Dispatcher.InvokeAsync(NextTip, DispatcherPriority.Loaded);
            tipTimer.Start();
            try
            {
                if (demo) await DemoRun();
                else await RealRun();
                tipTimer.Stop();
                Animate(false);
                OrbLabel.Text = L("ГОТОВ", "READY");
                Show(PageDone);
                if (LaunchAfter.IsChecked == true && !demo) Launch(null, null);
            }
            catch (Exception ex)
            {
                tipTimer.Stop();
                Animate(false);
                ErrText.Text = ex.Message == "checksum"
                    ? L("Файл скачался повреждённым (контрольная сумма не совпала). Попробуйте ещё раз.", "The download was corrupted (checksum mismatch). Please try again.")
                    : L("Ошибка: ", "Error: ") + ex.Message + "\n\n" + L("Проверьте интернет (или VPN) и повторите. Можно скачать установщик вручную со страницы релизов.", "Check your connection (or VPN) and retry. You can also download the installer from the releases page.");
                Show(PageError);
            }
            finally
            {
                busy = false;
            }
        }

        async Task RealRun()
        {
            if (rel == null) await LoadRelease();
            if (rel == null) throw new Exception(L("нет связи с GitHub", "can't reach GitHub"));
            string exe = payload;
            if (exe == null || !File.Exists(exe))
            {
                SetProgress(0, L("Скачиваю Jarvis…", "Downloading Jarvis…"), "");
                exe = await Setup.Download(rel, (got, total, speed) => Dispatcher.Invoke(() =>
                    SetProgress(0.8 * got / Math.Max(1, total), null, $"{got / 1048576} / {total / 1048576} {L("МБ", "MB")}  ·  {speed / 1048576:0.0} {L("МБ/с", "MB/s")}")), cts.Token);
            }
            var running = Setup.Running(dir);
            if (running.Length > 0)
            {
                var ok = MessageBox.Show(this, L("Jarvis сейчас запущен. Закрыть его и продолжить?", "Jarvis is running. Close it and continue?"), "Jarvis", MessageBoxButton.YesNo, MessageBoxImage.Question);
                if (ok != MessageBoxResult.Yes) throw new Exception(L("установка отменена", "installation cancelled"));
                foreach (var p in running) try { p.Kill(); p.WaitForExit(5000); } catch { }
            }
            SetProgress(0.8, L("Устанавливаю…", "Installing…"), L("Распаковка файлов", "Unpacking files"));
            var code = await Setup.Install(exe, dir, f => Dispatcher.Invoke(() => SetProgress(0.8 + 0.2 * f, null, null)));
            if (code != 0) throw new Exception(L($"установщик завершился с кодом {code}", $"the installer exited with code {code}"));
            if (Desktop.IsChecked != true)
                try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Jarvis.lnk")); } catch { }
            SetProgress(1, L("Готово", "Done"), "");
        }

        async Task DemoRun()
        {
            var total = rel?.Size ?? 300_000_000;
            SetProgress(0, L("Скачиваю Jarvis…", "Downloading Jarvis…"), "");
            for (int i = 1; i <= 30; i++)
            {
                await Task.Delay(180);
                var got = total * i / 30;
                SetProgress(0.8 * i / 30, null, $"{got / 1048576} / {total / 1048576} {L("МБ", "MB")}  ·  {28 + (i % 5) * 1.3:0.0} {L("МБ/с", "MB/s")}");
            }
            SetProgress(0.8, L("Устанавливаю…", "Installing…"), L("Распаковка файлов", "Unpacking files"));
            for (int i = 1; i <= 15; i++)
            {
                await Task.Delay(200);
                SetProgress(0.8 + 0.2 * i / 15, null, null);
            }
        }

        void Launch(object sender, RoutedEventArgs e)
        {
            var exe = Path.Combine(dir, "Jarvis.exe");
            if (File.Exists(exe) && !demo) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = dir });
            Close();
        }

        void ChangePath(object sender, RoutedEventArgs e)
        {
            using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = L("Куда установить Jarvis", "Where to install Jarvis"), SelectedPath = dir })
                if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                {
                    dir = d.SelectedPath.EndsWith("Jarvis", StringComparison.OrdinalIgnoreCase) ? d.SelectedPath : Path.Combine(d.SelectedPath, "Jarvis");
                    PathText.Text = dir;
                }
        }

        void Manual(object sender, RoutedEventArgs e) => Process.Start(new ProcessStartInfo(Setup.Repo + "/releases/latest") { UseShellExecute = true });

        void Drag(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        }

        void Minimize(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

        void CloseClick(object sender, RoutedEventArgs e)
        {
            if (busy && MessageBox.Show(this, L("Прервать установку?", "Cancel the installation?"), "Jarvis", MessageBoxButton.YesNo) != MessageBoxResult.Yes) return;
            cts.Cancel();
            Close();
        }
    }
}
