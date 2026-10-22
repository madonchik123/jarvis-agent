"""Objective evaluation of XTTS cloning configs against HELD-OUT real Jarvis clips.

Speaker similarity = cosine similarity of WavLM x-vectors (microsoft/wavlm-base-plus-sv) between generated speech and
real clips that were NOT used for conditioning. Higher is better. Reference points are printed for context:
  upper = similarity between different real clips of the voice, lower = a stock Piper voice.
"""
import os, sys, json, glob, time, itertools
os.environ['COQUI_TOS_AGREED'] = '1'
import numpy as np, soundfile as sf, torch, scipy.signal as ss
from transformers import WavLMForXVector, AutoFeatureExtractor
from TTS.api import TTS

here = os.path.dirname(os.path.abspath(__file__))
ds = os.path.join(here, 'dataset')
meta = json.load(open(os.path.join(ds, 'metadata.json'), encoding='utf8'))
for m in meta: m['path'] = os.path.join(ds, m['file'])

# hold out every 5th clip (>=1.2 s) as ground truth
held = [m for i, m in enumerate(meta) if i % 5 == 2 and m['sec'] >= 1.2]
pool = [m for m in meta if m not in held]
print(f'{len(pool)} conditioning clips, {len(held)} held-out clips')

dev = 'cuda'
sv = WavLMForXVector.from_pretrained('microsoft/wavlm-base-plus-sv').to(dev).eval()
fe = AutoFeatureExtractor.from_pretrained('microsoft/wavlm-base-plus-sv')


def load16(path_or_arr, sr=None):
    if isinstance(path_or_arr, str):
        x, sr = sf.read(path_or_arr, dtype='float32')
    else:
        x = path_or_arr
    if x.ndim > 1: x = x.mean(1)
    n = int(len(x) * 16000 / sr)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype('float32')


@torch.no_grad()
def embed(x16):
    inp = fe(x16, sampling_rate=16000, return_tensors='pt', padding=True).to(dev)
    e = sv(**inp).embeddings
    return torch.nn.functional.normalize(e, dim=-1)[0].cpu().numpy()


held_emb = [embed(load16(m['path'])) for m in held]
held_mean = np.mean(held_emb, 0); held_mean /= np.linalg.norm(held_mean)
# upper bound: leave-one-out similarity among real clips
upper = np.mean([float(np.dot(e, np.mean([x for j, x in enumerate(held_emb) if j != i], 0) / np.linalg.norm(np.mean([x for j, x in enumerate(held_emb) if j != i], 0)))) for i, e in enumerate(held_emb)])
print('upper bound (real vs real):', round(float(upper), 3))

# lower bound: stock Piper RU voice
piper = os.path.join(os.environ['APPDATA'], 'Jarvis', 'models', 'tts')
SENT_RU = ['Добрый вечер, сэр. Все системы работают в штатном режиме.', 'Я открыл калькулятор. Что-нибудь ещё?', 'Начинаю диагностику системы, это займёт несколько секунд.', 'К сожалению, сэр, это невозможно синтезировать.', 'Запрос выполнен. Желаете что-нибудь ещё?', 'Обнаружена неисправность в третьем модуле, сэр.']
SENT_EN = ['Good evening, sir. All systems are running at full capacity.', 'I have opened the calculator. Anything else?']
os.system(f'echo {SENT_RU[0]} | "{piper}\\piper\\piper.exe" --model "{piper}\\voices\\ru_RU-denis-medium.onnx" --output_file "{here}\\samples\\piper_ru.wav" --quiet')
try:
    lo = float(np.dot(embed(load16(os.path.join(here, 'samples', 'piper_ru.wav'))), held_mean))
    print('lower bound (Piper denis vs real):', round(lo, 3))
except Exception as e:
    print('lower bound skipped', e)

tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to(dev)
model = tts.synthesizer.tts_model


def ltas(x, sr, nfft=2048):
    f, t, S = ss.stft(x, sr, nperseg=nfft, noverlap=nfft // 2)
    P = np.abs(S) ** 2
    e = P.sum(0)
    keep = e > np.percentile(e, 40)  # speech frames only
    return f, P[:, keep].mean(1)


def eq_matcher(pool_clips):
    """FIR EQ that moves the average spectrum of XTTS output toward the real clips' average spectrum."""
    ref = []
    for m in pool_clips:
        x, sr = sf.read(m['path'], dtype='float32'); x = x if x.ndim == 1 else x.mean(1)
        ref.append(ltas(x, sr)[1])
    return np.mean(ref, 0)


target_psd = eq_matcher(pool)


def apply_eq(wav, sr, gen_psd, strength=1.0, maxdb=8.0):
    f, _ = ltas(wav, sr)
    ratio = np.sqrt((target_psd + 1e-12) / (gen_psd + 1e-12))
    db = 20 * np.log10(ratio)
    # smooth in ~1/3 octave
    k = 15
    db = np.convolve(np.pad(db, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    db = np.clip(db * strength, -maxdb, maxdb)
    db[f < 70] = 0; db[f > 11000] = np.minimum(db[f > 11000], 0)
    gain = 10 ** (db / 20)
    fir = ss.firwin2(1025, f / (sr / 2), gain, fs=2)  # linear phase
    y = ss.fftconvolve(wav, fir, mode='same')
    return y / max(1e-6, np.abs(y).max()) * np.abs(wav).max()


def synth(latents, text, lang, **kw):
    p = dict(temperature=0.65, length_penalty=1.0, repetition_penalty=5.0, top_k=50, top_p=0.85, speed=1.0, enable_text_splitting=True)
    p.update(kw)
    with torch.no_grad():
        out = model.inference(text, lang, latents[0], latents[1], **p)
    return np.asarray(out['wav'], dtype=np.float32)


def score(wavs):
    sims = [float(np.dot(embed(load16(w, 24000)), held_mean)) for w in wavs]
    return float(np.mean(sims))


def pick(clips, n, lo=2.4, hi=6.0):
    c = [m for m in clips if lo <= m['sec'] <= hi]
    c = sorted(c, key=lambda m: -m['sec'])
    return [m['path'] for m in c[:n]]


configs = []
for n in (6, 10, 20, 40):
    for gcl in (6, 15, 30):
        configs.append(dict(name=f'refs={n} cond_len={gcl}', refs=pick(pool, n, 1.2, 8), cond=dict(gpt_cond_len=gcl, gpt_cond_chunk_len=min(gcl, 6), max_ref_length=30)))
results = []
t_all = time.time()
cache = {}
for cfg in configs:
    t0 = time.time()
    try:
        lat = model.get_conditioning_latents(audio_path=cfg['refs'], **cfg['cond'])
    except Exception as e:
        print('skip', cfg['name'], e); continue
    wavs = [synth(lat, s, 'ru') for s in SENT_RU[:4]]
    sc = score(wavs)
    results.append((sc, cfg['name'], lat))
    print(f"{cfg['name']:28s} sim={sc:.3f}  ({time.time()-t0:.0f}s)", flush=True)

results.sort(key=lambda r: -r[0])
best_sc, best_name, best_lat = results[0]
print('BEST conditioning:', best_name, round(best_sc, 3))

# sampling sweep on the best conditioning
sweep = []
for temp, top_p, rep in itertools.product((0.3, 0.5, 0.65, 0.8), (0.7, 0.85), (2.0, 5.0)):
    wavs = [synth(best_lat, s, 'ru', temperature=temp, top_p=top_p, repetition_penalty=rep) for s in SENT_RU[:4]]
    sc = score(wavs)
    sweep.append((sc, dict(temperature=temp, top_p=top_p, repetition_penalty=rep)))
    print(f'  temp={temp} top_p={top_p} rep={rep}  sim={sc:.3f}', flush=True)
sweep.sort(key=lambda r: -r[0])
best_kw = sweep[0][1]
print('BEST sampling:', best_kw, round(sweep[0][0], 3))

# EQ matching on top
wavs = [synth(best_lat, s, 'ru', **best_kw) for s in SENT_RU]
base = score(wavs)
psd_gen = np.mean([ltas(w, 24000)[1] for w in wavs], 0)
for strength in (0.5, 0.8, 1.0):
    eqd = [apply_eq(w, 24000, psd_gen, strength) for w in wavs]
    print(f'  EQ strength={strength}: sim={score(eqd):.3f} (no EQ {base:.3f})', flush=True)

json.dump({'best_conditioning': best_name, 'best_sampling': best_kw, 'sim': sweep[0][0], 'upper': float(upper)}, open(os.path.join(here, 'eval_result.json'), 'w'))
os.makedirs(os.path.join(here, 'samples'), exist_ok=True)
for i, w in enumerate(wavs[:3]):
    sf.write(os.path.join(here, 'samples', f'best_{i}.wav'), w, 24000)
    sf.write(os.path.join(here, 'samples', f'best_eq_{i}.wav'), apply_eq(w, 24000, psd_gen, 0.8), 24000)
print('total', round(time.time() - t_all), 's')
