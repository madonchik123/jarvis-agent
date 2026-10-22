"""Same-text comparison against HELD-OUT real Jarvis clips.

For every held-out clip we synthesize its transcript and measure the DTW-aligned log-mel distance to the real
recording (lower = closer in timbre, spectral colour, effects AND prosody), plus the F0 mean/range gap.
Config sweep: reference selection, conditioning length, sampling, spectral EQ matching.
"""
import os, sys, json, time, itertools
os.environ['COQUI_TOS_AGREED'] = '1'
import numpy as np, soundfile as sf, torch, librosa, scipy.signal as ss
from TTS.api import TTS

here = os.path.dirname(os.path.abspath(__file__))
ds = os.path.join(here, 'dataset')
meta = json.load(open(os.path.join(ds, 'metadata.json'), encoding='utf8'))
for m in meta: m['path'] = os.path.join(ds, m['file'])
held = [m for i, m in enumerate(meta) if i % 5 == 2 and m['sec'] >= 1.2]
pool = [m for m in meta if m not in held]
print(f'{len(pool)} conditioning clips, {len(held)} held-out clips', flush=True)
SR = 24000


def mel(x):
    S = librosa.feature.melspectrogram(y=x, sr=SR, n_fft=1024, hop_length=256, n_mels=80, fmin=50, fmax=11000)
    L = np.log(S + 1e-5)
    return L - L.mean()  # remove overall gain only


def mel_dist(gen, real):
    A, B = mel(gen), mel(real)
    D, wp = librosa.sequence.dtw(A, B, metric='euclidean')
    path = np.array(wp)
    d = np.mean(np.linalg.norm(A[:, path[:, 0]] - B[:, path[:, 1]], axis=0))
    return float(d)


def f0stats(x):
    f0, v, _ = librosa.pyin(x, fmin=60, fmax=400, sr=SR, frame_length=1024)
    f = f0[~np.isnan(f0)]
    return (float(np.median(f)), float(np.std(np.log(f)))) if len(f) > 5 else (0.0, 0.0)


real = []
for m in held:
    x, sr = sf.read(m['path'], dtype='float32')
    real.append(x if x.ndim == 1 else x.mean(1))
real_f0 = [f0stats(x) for x in real]
print('real F0 median %.0f Hz, log-std %.3f' % (np.mean([a for a, _ in real_f0]), np.mean([b for _, b in real_f0])), flush=True)

tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to('cuda')
model = tts.synthesizer.tts_model


def ltas(x, nfft=2048):
    f, t, S = ss.stft(x, SR, nperseg=nfft, noverlap=nfft // 2)
    P = np.abs(S) ** 2
    e = P.sum(0)
    return f, P[:, e > np.percentile(e, 40)].mean(1)


ref_psd = np.mean([ltas(x)[1] for x in [sf.read(m['path'], dtype='float32')[0] for m in pool]], 0)


def eq_fix(wav, gen_psd, strength=1.0, maxdb=9.0):
    f, _ = ltas(wav)
    db = 20 * np.log10(np.sqrt((ref_psd + 1e-12) / (gen_psd + 1e-12)))
    k = 15
    db = np.convolve(np.pad(db, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    db = np.clip(db * strength, -maxdb, maxdb)
    db[f < 70] = 0
    fir = ss.firwin2(1025, f / (SR / 2), 10 ** (db / 20), fs=2)
    y = ss.fftconvolve(wav, fir, mode='same')
    return y / max(1e-6, np.abs(y).max()) * np.abs(wav).max()


def synth(lat, text, **kw):
    p = dict(temperature=0.5, length_penalty=1.0, repetition_penalty=5.0, top_k=50, top_p=0.85, speed=1.0, enable_text_splitting=True)
    p.update(kw)
    with torch.no_grad():
        out = model.inference(text, 'ru', lat[0], lat[1], **p)
    return np.asarray(out['wav'], dtype=np.float32)


def evaluate(lat, eq=0.0, psd=None, **kw):
    gens = [synth(lat, m['text'], **kw) for m in held]
    if eq:
        psd = np.mean([ltas(g)[1] for g in gens], 0)
        gens = [eq_fix(g, psd, eq) for g in gens]
    d = np.mean([mel_dist(g, r) for g, r in zip(gens, real)])
    f = [f0stats(g) for g in gens]
    return float(d), gens, (np.mean([a for a, _ in f]), np.mean([b for _, b in f]))


def pick(clips, n, lo, hi):
    c = sorted([m for m in clips if lo <= m['sec'] <= hi], key=lambda m: -m['sec'])
    return [m['path'] for m in c[:n]]


# reference points
os.makedirs(os.path.join(here, 'samples'), exist_ok=True)
piper = os.path.join(os.environ['APPDATA'], 'Jarvis', 'models', 'tts')
pd_ = []
for i, m in enumerate(held):
    out = os.path.join(here, 'samples', f'_p{i}.wav')
    open(os.path.join(here, '_t.txt'), 'w', encoding='utf8').write(m['text'])
    os.system(f'type "{os.path.join(here, "_t.txt")}" | "{piper}\\piper\\piper.exe" --model "{piper}\\voices\\ru_RU-denis-medium.onnx" --output_file "{out}" --quiet 2>nul')
    try:
        x, sr = sf.read(out, dtype='float32'); x = librosa.resample(x, orig_sr=sr, target_sr=SR); pd_.append(mel_dist(x, real[i]))
    except Exception:
        pass
if pd_:
    print('Piper denis (stock RU voice):        mel-dist %.3f' % np.mean(pd_), flush=True)
rr = [mel_dist(real[i], real[(i + 1) % len(real)]) for i in range(len(real))]
print('different real clips (ceiling noise): mel-dist %.3f  (different texts, so only a rough scale)' % np.mean(rr), flush=True)

results = []
t0 = time.time()
for n, lo, hi in ((6, 2.4, 6), (10, 2.4, 6), (20, 1.2, 8), (43, 0.5, 30)):
    for gcl in (6, 30):
        refs = pick(pool, n, lo, hi)
        lat = model.get_conditioning_latents(audio_path=refs, gpt_cond_len=gcl, gpt_cond_chunk_len=min(gcl, 6), max_ref_length=30)
        d, _, f0 = evaluate(lat)
        results.append((d, f'refs={n} ({len(refs)} clips) cond_len={gcl}', lat))
        print(f'refs={n:2d} ({len(refs):2d} clips) cond_len={gcl:2d}   mel-dist {d:.3f}   F0 {f0[0]:.0f}Hz/{f0[1]:.3f}   [{time.time()-t0:.0f}s]', flush=True)
results.sort(key=lambda r: r[0])
bd, bname, blat = results[0]
print('BEST conditioning:', bname, round(bd, 3), flush=True)

best = (bd, {})
for temp, top_p, rep, tk in itertools.product((0.2, 0.4, 0.65), (0.8, 0.95), (2.0, 5.0), (30, 70)):
    d, _, _ = evaluate(blat, temperature=temp, top_p=top_p, repetition_penalty=rep, top_k=tk)
    print(f'  temp={temp} top_p={top_p} rep={rep} top_k={tk}  mel-dist {d:.3f}', flush=True)
    if d < best[0]:
        best = (d, dict(temperature=temp, top_p=top_p, repetition_penalty=rep, top_k=tk))
print('BEST sampling:', best, flush=True)

for eq in (0.0, 0.5, 0.8, 1.0):
    d, gens, f0 = evaluate(blat, eq=eq, **best[1])
    print(f'EQ strength {eq}: mel-dist {d:.3f}', flush=True)
    if eq in (0.0, 0.8):
        for i in range(3):
            sf.write(os.path.join(here, 'samples', f'held{i}_eq{eq}.wav'), gens[i], SR)
for i in range(3):
    sf.write(os.path.join(here, 'samples', f'held{i}_REAL.wav'), real[i], SR)
json.dump({'conditioning': bname, 'sampling': best[1], 'mel_dist': best[0]}, open(os.path.join(here, 'eval_mel_result.json'), 'w'))
print('done', round(time.time() - t0), 's', flush=True)
