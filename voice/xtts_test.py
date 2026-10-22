import os, json, glob, time
os.environ['COQUI_TOS_AGREED'] = '1'   # CPML (non-commercial) licence for XTTS-v2 — personal use
import torch
from TTS.api import TTS

here = os.path.dirname(os.path.abspath(__file__))
meta = json.load(open(os.path.join(here, 'dataset', 'metadata.json'), encoding='utf8'))
# reference set: the cleanest mid-length clips (3-8 s each), ~25 s total
refs = [os.path.join(here, 'dataset', m['file']) for m in meta if 2.4 <= m['sec'] <= 5][:9]
print('refs', len(refs))
t0 = time.time()
tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to('cuda')
print('loaded in', round(time.time() - t0, 1), 's')
out = os.path.join(here, 'samples'); os.makedirs(out, exist_ok=True)
tests = [('ru', 'Добрый вечер, сэр. Все системы работают в штатном режиме, и я готов к выполнению ваших указаний.'),
         ('ru', 'Я открыл калькулятор. Что-нибудь ещё?'),
         ('en', 'Good evening, sir. All systems are running at full capacity, and I am ready for your instructions.')]
for i, (lang, text) in enumerate(tests):
    t = time.time()
    tts.tts_to_file(text=text, speaker_wav=refs, language=lang, file_path=os.path.join(out, f'xtts_{i}_{lang}.wav'))
    print(i, lang, 'gen', round(time.time() - t, 2), 's')
print('done')
