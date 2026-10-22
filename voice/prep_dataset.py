"""Prepare the user's Russian Jarvis clips: mono, 24 kHz, trimmed, transcript from file name."""
import glob, os, re, wave, json
import numpy as np
import soundfile as sf

SRC = os.path.join(os.path.dirname(__file__), '..', 'RuJarvisSounds')
OUT = os.path.join(os.path.dirname(__file__), 'dataset')
os.makedirs(OUT, exist_ok=True)

def resample(x, sr_in, sr_out):
    if sr_in == sr_out: return x
    n = int(round(len(x) * sr_out / sr_in))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)

def clean_name(n):
    n = os.path.splitext(n)[0]
    n = re.sub(r'\(.*?\)', '', n)   # "(второй)"
    n = re.sub(r'=\)|\s\d$', '', n)
    return re.sub(r'\s+', ' ', n).strip(' ,.')

rows = []
for f in sorted(glob.glob(os.path.join(SRC, '*.wav'))):
    name = os.path.basename(f)
    if 'Песня' in name or 'приветствие' in name:  # music / jingle, not speech
        continue
    x, sr = sf.read(f, dtype='float32')
    if x.ndim > 1: x = x.mean(axis=1)
    x = resample(x, sr, 24000)
    # trim silence
    thr = 0.01 * max(1e-6, np.abs(x).max())
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0: continue
    x = x[max(0, idx[0] - 1200): idx[-1] + 2400]
    x = x / max(1e-6, np.abs(x).max()) * 0.95
    text = clean_name(name)
    out = os.path.join(OUT, f'{len(rows):03d}.wav')
    sf.write(out, x, 24000, subtype='PCM_16')
    rows.append({'file': os.path.basename(out), 'text': text, 'sec': round(len(x) / 24000, 2), 'orig': name})

json.dump(rows, open(os.path.join(OUT, 'metadata.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print(len(rows), 'clips,', round(sum(r['sec'] for r in rows), 1), 'sec')
for r in rows[:60]: print(r['sec'], r['text'])
