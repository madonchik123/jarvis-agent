using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

namespace JarvisNative
{
    /// <summary>Windows.Media.Ocr (built into Windows 10/11): Russian and English recognisers, best result wins.</summary>
    internal static class Ocr
    {
        static List<OcrEngine> engines;
        static readonly object gate = new object();

        static List<OcrEngine> Engines()
        {
            lock (gate)
            {
                if (engines != null) return engines;
                engines = new List<OcrEngine>();
                foreach (var tag in new[] { "ru", "en-US", "en" })
                {
                    try
                    {
                        var lang = new Language(tag);
                        if (OcrEngine.IsLanguageSupported(lang))
                        {
                            var e = OcrEngine.TryCreateFromLanguage(lang);
                            if (e != null && !engines.Any(x => x.RecognizerLanguage.LanguageTag == e.RecognizerLanguage.LanguageTag)) engines.Add(e);
                        }
                    }
                    catch { }
                }
                if (engines.Count == 0)
                {
                    var e = OcrEngine.TryCreateFromUserProfileLanguages();
                    if (e != null) engines.Add(e);
                }
                return engines;
            }
        }

        public static string Languages() => string.Join(",", Engines().Select(e => e.RecognizerLanguage.LanguageTag));

        static T Wait<T>(global::Windows.Foundation.IAsyncOperation<T> op) => op.AsTask().GetAwaiter().GetResult();

        public static Dictionary<string, object> RunFile(string path, int ox, int oy)
        {
            var file = Wait(StorageFile.GetFileFromPathAsync(path));
            using (IRandomAccessStream stream = Wait(file.OpenAsync(FileAccessMode.Read)))
            {
                var dec = Wait(BitmapDecoder.CreateAsync(stream));
                using (var bmp = Wait(dec.GetSoftwareBitmapAsync()))
                    return Run(bmp, ox, oy);
            }
        }

        public static Dictionary<string, object> Run(SoftwareBitmap bmp, int ox, int oy)
        {
            var list = Engines();
            if (list.Count == 0) throw new Exception("no OCR language is installed (Windows Settings → Language)");
            OcrResult best = null;
            string bestLang = "";
            double bestScore = -1;
            foreach (var eng in list)
            {
                var r = Wait(eng.RecognizeAsync(bmp));
                // letters in real words count; a Latin engine reading Cyrillic produces digit/symbol soup ("KaJ1bKynATop")
                double score = 0;
                foreach (var ln in r.Lines)
                    foreach (var w in ln.Words)
                    {
                        var t = w.Text;
                        int letters = t.Count(char.IsLetter), cyr = t.Count(c => c >= 'Ѐ' && c <= 'ӿ');
                        bool mixed = letters > 0 && t.Any(char.IsDigit) && t.Length > 3;
                        score += mixed ? letters * 0.3 : letters;
                        if (eng.RecognizerLanguage.LanguageTag.StartsWith("ru")) score += cyr * 0.5;
                    }
                if (score > bestScore) { best = r; bestScore = score; bestLang = eng.RecognizerLanguage.LanguageTag; }
            }
            var lines = new List<object>();
            foreach (var ln in best.Lines)
            {
                var words = ln.Words.Select(w => new Dictionary<string, object>
                {
                    ["t"] = w.Text, ["x"] = (int)(w.BoundingRect.X + ox), ["y"] = (int)(w.BoundingRect.Y + oy), ["w"] = (int)w.BoundingRect.Width, ["h"] = (int)w.BoundingRect.Height
                }).ToList();
                if (words.Count == 0) continue;
                int x1 = words.Min(w => (int)w["x"]), y1 = words.Min(w => (int)w["y"]);
                int x2 = words.Max(w => (int)w["x"] + (int)w["w"]), y2 = words.Max(w => (int)w["y"] + (int)w["h"]);
                lines.Add(new Dictionary<string, object> { ["text"] = ln.Text, ["x"] = x1, ["y"] = y1, ["w"] = x2 - x1, ["h"] = y2 - y1, ["words"] = words });
            }
            return new Dictionary<string, object> { ["lang"] = bestLang, ["text"] = best.Text, ["lines"] = lines };
        }
    }
}
