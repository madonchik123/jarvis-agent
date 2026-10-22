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


def synth(lat, text, seed=0, **kw):
    torch.manual_seed(seed); np.random.seed(seed)
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


def evaluate_rep(lat, eq=0.0, reps=3, **kw):
    ds_, f0s_ = [], []
    allg = []
    for r in range(reps):
        gens = [synth(lat, m['text'], seed=r, **kw) for m in held]
        if eq:
            psd = np.mean([ltas(g)[1] for g in gens], 0)
            gens = [eq_fix(g, psd, eq) for g in gens]
        ds_.append(np.mean([mel_dist(g, rr) for g, rr in zip(gens, real)]))
        allg.append(gens)
    return float(np.mean(ds_)), float(np.std(ds_)), allg[0]

refs = pick(pool, 43, 0.5, 30)
lat = model.get_conditioning_latents(audio_path=refs, gpt_cond_len=6, gpt_cond_chunk_len=6, max_ref_length=30)
res = {}
m, sd, g = evaluate_rep(lat); res['zero-shot'] = m
print(f'ZERO-SHOT                 mel-dist {m:.3f} +- {sd:.3f}', flush=True)
for i in range(3): sf.write(os.path.join(here, 'samples', f'cmp{i}_zeroshot.wav'), g[i], SR)
for eq in (0.6,):
    m, sd, g = evaluate_rep(lat, eq=eq); print(f'ZERO-SHOT + EQ {eq}         mel-dist {m:.3f} +- {sd:.3f}', flush=True)

sd_ft = torch.load(os.path.join(here, 'ft_run', 'gpt_best.pth'), map_location='cuda')
print('load ft:', model.gpt.load_state_dict(sd_ft, strict=False).unexpected_keys[:2], flush=True)
lat2 = model.get_conditioning_latents(audio_path=refs, gpt_cond_len=6, gpt_cond_chunk_len=6, max_ref_length=30)
m, sd, g = evaluate_rep(lat2); res['finetuned'] = m
print(f'FINE-TUNED (epoch 7)      mel-dist {m:.3f} +- {sd:.3f}', flush=True)
for i in range(3): sf.write(os.path.join(here, 'samples', f'cmp{i}_finetuned.wav'), g[i], SR)
for eq in (0.5, 0.8):
    m, sd, g = evaluate_rep(lat2, eq=eq); print(f'FINE-TUNED + EQ {eq}        mel-dist {m:.3f} +- {sd:.3f}', flush=True)
    if eq == 0.5:
        for i in range(3): sf.write(os.path.join(here, 'samples', f'cmp{i}_finetuned_eq.wav'), g[i], SR)
for i in range(3): sf.write(os.path.join(here, 'samples', f'cmp{i}_REAL.wav'), real[i], SR)
print('done', flush=True)
