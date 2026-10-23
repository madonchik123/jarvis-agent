using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using static JarvisNative.Win32;

namespace JarvisNative
{
    /// <summary>Keyboard and mouse through SendInput (layout-independent key names, X11 keysym names, Unicode typing).</summary>
    internal static class Input
    {
        static readonly int Size = Marshal.SizeOf(typeof(INPUT));

        // normalised name (lower case, no "_" "-" spaces) -> virtual key
        static readonly Dictionary<string, int> VK = new Dictionary<string, int>
        {
            ["enter"] = 0x0D, ["return"] = 0x0D, ["kpenter"] = 0x0D, ["tab"] = 0x09, ["esc"] = 0x1B, ["escape"] = 0x1B,
            ["space"] = 0x20, ["backspace"] = 0x08, ["delete"] = 0x2E, ["del"] = 0x2E, ["insert"] = 0x2D, ["ins"] = 0x2D,
            ["home"] = 0x24, ["end"] = 0x23, ["pageup"] = 0x21, ["prior"] = 0x21, ["pagedown"] = 0x22, ["next"] = 0x22,
            ["left"] = 0x25, ["up"] = 0x26, ["right"] = 0x27, ["down"] = 0x28,
            ["ctrl"] = 0x11, ["control"] = 0x11, ["controll"] = 0xA2, ["controlr"] = 0xA3, ["ctrll"] = 0xA2, ["ctrlr"] = 0xA3,
            ["shift"] = 0x10, ["shiftl"] = 0xA0, ["shiftr"] = 0xA1, ["alt"] = 0x12, ["altl"] = 0xA4, ["altr"] = 0xA5, ["option"] = 0x12,
            ["win"] = 0x5B, ["windows"] = 0x5B, ["super"] = 0x5B, ["superl"] = 0x5B, ["superr"] = 0x5C, ["cmd"] = 0x5B, ["meta"] = 0x5B, ["metal"] = 0x5B,
            ["menu"] = 0x5D, ["apps"] = 0x5D, ["capslock"] = 0x14, ["numlock"] = 0x90, ["scrolllock"] = 0x91, ["pause"] = 0x13,
            ["printscreen"] = 0x2C, ["print"] = 0x2C, ["prtsc"] = 0x2C,
            ["volumeup"] = 0xAF, ["volumedown"] = 0xAE, ["mute"] = 0xAD, ["volumemute"] = 0xAD, ["playpause"] = 0xB3, ["play"] = 0xB3,
            ["nexttrack"] = 0xB0, ["prevtrack"] = 0xB1, ["stop"] = 0xB2, ["mediastop"] = 0xB2,
            ["xf86audioraisevolume"] = 0xAF, ["xf86audiolowervolume"] = 0xAE, ["xf86audiomute"] = 0xAD, ["xf86audioplay"] = 0xB3,
            ["xf86audionext"] = 0xB0, ["xf86audioprev"] = 0xB1, ["xf86audiostop"] = 0xB2,
            ["browserback"] = 0xA6, ["browserforward"] = 0xA7, ["browserrefresh"] = 0xA8,
            ["kpadd"] = 0x6B, ["kpsubtract"] = 0x6D, ["kpmultiply"] = 0x6A, ["kpdivide"] = 0x6F, ["kpdecimal"] = 0x6E,
            ["numpadadd"] = 0x6B, ["numpadsubtract"] = 0x6D, ["numpadmultiply"] = 0x6A, ["numpaddivide"] = 0x6F, ["numpaddecimal"] = 0x6E,
        };
        // keysym names of printable characters
        static readonly Dictionary<string, char> CHARS = new Dictionary<string, char>
        {
            ["period"] = '.', ["comma"] = ',', ["minus"] = '-', ["plus"] = '+', ["equal"] = '=', ["slash"] = '/', ["backslash"] = '\\',
            ["semicolon"] = ';', ["colon"] = ':', ["apostrophe"] = '\'', ["quotedbl"] = '"', ["bracketleft"] = '[', ["bracketright"] = ']',
            ["braceleft"] = '{', ["braceright"] = '}', ["grave"] = '`', ["asciitilde"] = '~', ["exclam"] = '!', ["at"] = '@', ["numbersign"] = '#',
            ["dollar"] = '$', ["percent"] = '%', ["asciicircum"] = '^', ["ampersand"] = '&', ["asterisk"] = '*', ["parenleft"] = '(',
            ["parenright"] = ')', ["underscore"] = '_', ["less"] = '<', ["greater"] = '>', ["question"] = '?', ["bar"] = '|',
        };
        // keys that need the "extended" flag
        static readonly HashSet<int> EXT = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0xA3, 0xA5, 0x6F, 0x90 };

        static string Norm(string k) => new string(k.Trim().ToLowerInvariant().Where(c => c != '_' && c != '-' && c != ' ').ToArray());

        /// <summary>Key name → virtual key, plus whether Shift must be held to produce it (for punctuation).</summary>
        public static (int vk, bool shift) Resolve(string key)
        {
            var raw = key.Trim();
            var k = Norm(raw);
            if (k.Length == 0 && raw.Length > 0) k = raw; // "+" or "-" given literally
            if (VK.TryGetValue(k, out int v)) return (v, false);
            if (k.Length >= 2 && k[0] == 'f' && int.TryParse(k.Substring(1), out int fn) && fn >= 1 && fn <= 24) return (0x6F + fn, false);
            if ((k.StartsWith("kp") || k.StartsWith("numpad")) && int.TryParse(k.Substring(k.StartsWith("kp") ? 2 : 6), out int np) && np >= 0 && np <= 9) return (0x60 + np, false);
            if (k.Length == 1 && ((k[0] >= 'a' && k[0] <= 'z') || (k[0] >= '0' && k[0] <= '9'))) return (char.ToUpperInvariant(k[0]), false); // layout independent
            char ch = '\0';
            if (CHARS.TryGetValue(k, out char c)) ch = c;
            else if (raw.Length == 1) ch = raw[0];
            if (ch != '\0')
            {
                short r = VkKeyScan(ch);
                if (r == -1) throw new Exception($"cannot press '{key}' with the current keyboard layout");
                return (r & 0xFF, (r & 0x100) != 0);
            }
            throw new Exception($"unknown key '{key}'");
        }

        static INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var i = new INPUT { type = 1 };
            i.u.ki.vk = vk;
            i.u.ki.scan = scan;
            i.u.ki.flags = flags;
            return i;
        }

        public static void KeyDown(int vk, bool scanCodes = false) => SendKey(vk, false, scanCodes);
        public static void KeyUp(int vk, bool scanCodes = false) => SendKey(vk, true, scanCodes);

        static void SendKey(int vk, bool up, bool scanCodes)
        {
            uint ext = EXT.Contains(vk) ? 1u : 0u;
            uint flags = ext | (up ? 2u : 0u);
            INPUT i = scanCodes ? Key(0, (ushort)MapVirtualKey((uint)vk, 0), flags | 0x8u) : Key((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), flags);
            SendInput(1, new[] { i }, Size);
        }

        static List<(int vk, bool shift)> Chord(string chord) =>
            chord.Split('+').Select(p => p.Trim()).Where(p => p.Length > 0).Select(Resolve).ToList();

        /// <summary>"ctrl+shift+t", "Control_L+a", several chords separated by spaces: "ctrl+a delete".</summary>
        public static void Keys(string combo, bool scanCodes = false)
        {
            // "+" alone (or "ctrl++") means the plus key
            foreach (var chordRaw in combo.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var chord = chordRaw.EndsWith("++") ? chordRaw.Substring(0, chordRaw.Length - 2) + "+plus" : chordRaw == "+" ? "plus" : chordRaw;
                var keys = Chord(chord);
                var vks = new List<int>();
                if (keys.Any(k => k.shift) && !keys.Any(k => k.vk == 0x10)) vks.Add(0x10);
                vks.AddRange(keys.Select(k => k.vk));
                foreach (var v in vks) KeyDown(v, scanCodes);
                Thread.Sleep(25);
                for (int i = vks.Count - 1; i >= 0; i--) KeyUp(vks[i], scanCodes);
                Thread.Sleep(40);
            }
        }

        public static void HoldDown(string chord, bool scanCodes)
        {
            foreach (var k in Chord(chord)) KeyDown(k.vk, scanCodes);
        }

        public static void HoldUp(string chord, bool scanCodes)
        {
            var ks = Chord(chord);
            for (int i = ks.Count - 1; i >= 0; i--) KeyUp(ks[i].vk, scanCodes);
        }

        /// <summary>Real Unicode keystrokes (any language / emoji), independent of the keyboard layout.</summary>
        public static void TypeText(string s, int perCharMs = 4)
        {
            foreach (var line in s.Replace("\r\n", "\n").Split('\n').Select((t, i) => (t, i)))
            {
                if (line.i > 0) { Keys("shift+enter"); }
                foreach (char c in line.t)
                {
                    SendInput(2, new[] { Key(0, c, 0x4), Key(0, c, 0x4 | 0x2) }, Size);
                    if (perCharMs > 0) Thread.Sleep(perCharMs);
                }
            }
        }

        public static void Mouse(uint flags, int data = 0)
        {
            var i = new INPUT { type = 0 };
            i.u.mi.flags = flags;
            i.u.mi.data = (uint)data;
            SendInput(1, new[] { i }, Size);
        }

        static (uint down, uint up) Buttons(string button)
        {
            switch ((button ?? "left").ToLowerInvariant())
            {
                case "right": case "r": return (0x8, 0x10);
                case "middle": case "m": return (0x20, 0x40);
                default: return (0x2, 0x4);
            }
        }

        public static void MoveTo(int x, int y) => SetCursorPos(x, y);

        public static void Click(int x, int y, string button = "left", int count = 1)
        {
            SetCursorPos(x, y);
            Thread.Sleep(40);
            var (down, up) = Buttons(button);
            for (int i = 0; i < Math.Max(1, count); i++)
            {
                Mouse(down);
                Thread.Sleep(30);
                Mouse(up);
                Thread.Sleep(60);
            }
        }

        public static void Button(string button, bool down)
        {
            var (d, u) = Buttons(button);
            Mouse(down ? d : u);
        }

        public static void Drag(int x1, int y1, int x2, int y2, string button = "left")
        {
            var (d, u) = Buttons(button);
            SetCursorPos(x1, y1);
            Thread.Sleep(50);
            Mouse(d);
            for (int i = 1; i <= 16; i++)
            {
                SetCursorPos(x1 + (x2 - x1) * i / 16, y1 + (y2 - y1) * i / 16);
                Thread.Sleep(12);
            }
            Thread.Sleep(60);
            Mouse(u);
        }

        /// <summary>Wheel, one notch at a time (apps with smooth scrolling drop a single huge delta).</summary>
        public static void Wheel(int notchesY, int notchesX)
        {
            for (int i = 0; i < Math.Abs(notchesY); i++) { Mouse(0x800, -Math.Sign(notchesY) * 120); Thread.Sleep(18); }
            for (int i = 0; i < Math.Abs(notchesX); i++) { Mouse(0x1000, Math.Sign(notchesX) * 120); Thread.Sleep(18); }
        }
    }
}
