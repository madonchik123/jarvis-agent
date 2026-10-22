"""Tiny local HTTP sidecar around XTTS-v2 for the Jarvis app.

  python xtts_server.py --refs <folder with reference .wav clips> --port 47900

POST /tts   {"text": "...", "lang": "ru"|"en", "speed": 1.0}  ->  audio/wav (24 kHz, mono, 16-bit)
GET  /health -> "ok" once the model is loaded and the speaker latents are computed

The reference clips are the user's own Jarvis recordings; speaker latents are computed once at start-up.
XTTS-v2 is released under the Coqui Public Model License (non-commercial use).
"""
import argparse
import glob
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault('COQUI_TOS_AGREED', '1')  # CPML (non-commercial) — personal use

ap = argparse.ArgumentParser()
ap.add_argument('--refs', required=True)
ap.add_argument('--port', type=int, default=47900)
ap.add_argument('--max-refs', type=int, default=43)
ap.add_argument('--gpt', default='', help='fine-tuned GPT weights (gpt_best.pth); auto-detected next to the script if omitted')
ap.add_argument('--parent', type=int, default=0, help='exit when this process id disappears (the Jarvis app)')
ap.add_argument('--eq', type=float, default=0.0, help='spectral EQ matching strength 0..1 (colour of the real recordings)')
args = ap.parse_args()

import numpy as np
import soundfile as sf
import torch
import scipy.signal as ss
from TTS.api import TTS

device = 'cuda' if torch.cuda.is_available() else 'cpu'
t0 = time.time()
tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to(device)
model = tts.synthesizer.tts_model

gpt_path = args.gpt
if not gpt_path:
    for cand in (os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gpt_best.pth'), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ft_run', 'gpt_best.pth')):
        if os.path.exists(cand):
            gpt_path = cand
            break
if gpt_path and os.path.exists(gpt_path):
    missing = model.gpt.load_state_dict(torch.load(gpt_path, map_location=device), strict=False)
    print('loaded fine-tuned GPT:', gpt_path, flush=True)

refs = sorted(glob.glob(os.path.join(args.refs, '*.wav')))
# measured best on held-out real clips: use ALL reference clips (cond_len 6)
meta_path = os.path.join(args.refs, 'metadata.json')
if os.path.exists(meta_path):
    meta = json.load(open(meta_path, encoding='utf8'))
    good = [os.path.join(args.refs, m['file']) for m in meta if 0.5 <= m['sec'] <= 30]
    refs = good or refs
refs = refs[: args.max_refs]
if not refs:
    print('no reference clips in', args.refs, file=sys.stderr)
    sys.exit(2)
latents = {'gpt': None, 'spk': None}
latents['gpt'], latents['spk'] = model.get_conditioning_latents(audio_path=refs, gpt_cond_len=6, gpt_cond_chunk_len=6, max_ref_length=30)
print(f'xtts ready on {device} in {time.time() - t0:.1f}s with {len(refs)} refs', flush=True)

lock = threading.Lock()

# ---- optional spectral EQ: move the average spectrum of the output toward the real recordings -------------------
def ltas(x, sr=24000, nfft=2048):
    f, t, S = ss.stft(x, sr, nperseg=nfft, noverlap=nfft // 2)
    P = np.abs(S) ** 2
    e = P.sum(0)
    return f, P[:, e > np.percentile(e, 40)].mean(1)

EQ_FIR = None
if args.eq > 0:
    all_refs = sorted(glob.glob(os.path.join(args.refs, '*.wav')))
    ref_psd = []
    for rp in all_refs:
        x, sr = sf.read(rp, dtype='float32'); x = x if x.ndim == 1 else x.mean(1)
        ref_psd.append(ltas(x, sr)[1])
    ref_psd = np.mean(ref_psd, 0)
    gens = []
    for t in ['Добрый вечер, сэр. Все системы работают в штатном режиме.', 'Я открыл калькулятор. Что-нибудь ещё?', 'Начинаю диагностику системы, это займёт несколько секунд.']:
        with torch.no_grad():
            o = model.inference(t, 'ru', latents['gpt'], latents['spk'], temperature=0.5, top_k=50, top_p=0.85, repetition_penalty=5.0)
        gens.append(np.asarray(o['wav'], dtype=np.float32))
    f, _ = ltas(gens[0])
    gen_psd = np.mean([ltas(g)[1] for g in gens], 0)
    db = 20 * np.log10(np.sqrt((ref_psd + 1e-12) / (gen_psd + 1e-12)))
    k = 15
    db = np.convolve(np.pad(db, k // 2, mode='edge'), np.ones(k) / k, mode='valid')
    db = np.clip(db * args.eq, -9, 9)
    db[f < 70] = 0
    EQ_FIR = ss.firwin2(1025, f / 12000.0, 10 ** (db / 20), fs=2)
    print(f'EQ matching enabled (strength {args.eq})', flush=True)


def post(wav):
    if EQ_FIR is None:
        return wav
    y = ss.fftconvolve(wav, EQ_FIR, mode='same')
    return (y / max(1e-6, np.abs(y).max()) * np.abs(wav).max()).astype(np.float32)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/tts':
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get('content-length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
            text = (body.get('text') or '').strip()
            lang = body.get('lang', 'ru')
            speed = float(body.get('speed', 1.0))
            with lock:
                out = model.inference(
                    text, lang, latents['gpt'], latents['spk'],
                    temperature=0.65, length_penalty=1.0, repetition_penalty=5.0, top_k=50, top_p=0.85,
                    speed=speed, enable_text_splitting=True,
                )
            wav = post(np.asarray(out['wav'], dtype=np.float32))
            buf = io.BytesIO()
            sf.write(buf, wav, 24000, format='WAV', subtype='PCM_16')
            data = buf.getvalue()
            self.send_response(200)
            self.send_header('content-type', 'audio/wav')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            msg = str(e).encode('utf8', 'replace')
            self.send_response(500)
            self.send_header('content-length', str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def _watch_parent(pid):
    # never outlive the app: an orphaned engine would keep ~5 GB of VRAM and break the next start
    import ctypes
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not h:
        os._exit(0)
    while True:
        if k32.WaitForSingleObject(h, 2000) == 0:  # signalled = process ended
            os._exit(0)


if args.parent and os.name == 'nt':
    threading.Thread(target=_watch_parent, args=(args.parent,), daemon=True).start()

ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
