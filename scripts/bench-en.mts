// English recogniser benchmark: Whisper base / small vs Parakeet-TDT-110M on real recordings (speed, memory, text).
import { join } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const base = join(process.env.APPDATA!, 'Jarvis', 'models', 'stt')
const wavs = [
  join(base, 'sherpa-onnx-whisper-base', 'test_wavs', '0.wav'),
  join(base, 'sherpa-onnx-whisper-base', 'test_wavs', '1.wav'),
  join(base, 'sherpa-onnx-whisper-base', 'test_wavs', '8k.wav'),
  join(base, 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8', 'test_wavs', 'en-english.wav')
]
const refs = [
  'AFTER EARLY NIGHTFALL THE YELLOW LAMPS WOULD LIGHT UP HERE AND THERE THE SQUALID QUARTER OF THE BROTHELS',
  'GOD AS A DIRECT CONSEQUENCE OF THE SIN WHICH MAN THUS PUNISHED HAD GIVEN HER A LOVELY CHILD WHOSE PLACE WAS ON THAT SAME DISHONOURED BOSOM TO CONNECT HER PARENT FOR EVER WITH THE RACE AND DESCENT OF MORTALS AND TO BE FINALLY A BLESSED SOUL IN HEAVEN',
  'YET THESE THOUGHTS AFFECTED HESTER PRYNNE LESS WITH HOPE THAN APPREHENSION',
  ''
]
const rss = () => Math.round(process.memoryUsage().rss / 1048576)

function wer(ref: string, hyp: string) {
  const r = ref.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean)
  const h = hyp.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean)
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  return r.length ? d[r.length][h.length] / r.length : 0
}

const configs: Record<string, any> = {
  'whisper-base': () => ({ whisper: { encoder: `${base}/sherpa-onnx-whisper-base/base-encoder.int8.onnx`, decoder: `${base}/sherpa-onnx-whisper-base/base-decoder.int8.onnx`, language: 'en', task: 'transcribe', tailPaddings: 800 }, tokens: `${base}/sherpa-onnx-whisper-base/base-tokens.txt` }),
  'whisper-small': () => ({ whisper: { encoder: `${base}/sherpa-onnx-whisper-small/small-encoder.int8.onnx`, decoder: `${base}/sherpa-onnx-whisper-small/small-decoder.int8.onnx`, language: 'en', task: 'transcribe', tailPaddings: 800 }, tokens: `${base}/sherpa-onnx-whisper-small/small-tokens.txt` }),
  'parakeet-110m': () => {
    const d = `${base}/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8`
    return { transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` }, tokens: `${d}/tokens.txt`, modelType: 'nemo_transducer' }
  }
}

const which = process.argv[2]
const r0 = rss()
const t0 = Date.now()
const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { ...configs[which](), numThreads: 4, provider: 'cpu', debug: false } })
const loadMs = Date.now() - t0
console.log(`## ${which}: load ${loadMs} ms, RSS +${rss() - r0} MB`)
let tot = 0
let n = 0
for (let i = 0; i < wavs.length; i++) {
  const w = sherpa.readWave(wavs[i])
  const s = rec.createStream()
  s.acceptWaveform({ sampleRate: w.sampleRate, samples: w.samples })
  const t = Date.now()
  rec.decode(s)
  const ms = Date.now() - t
  const text = (rec.getResult(s).text || '').trim()
  const e = refs[i] ? wer(refs[i], text) : NaN
  if (!isNaN(e)) {
    tot += e
    n++
  }
  console.log(`  ${(w.samples.length / w.sampleRate).toFixed(1)}s audio, ${ms} ms${isNaN(e) ? '' : `, WER ${(e * 100).toFixed(0)}%`}  → ${text.slice(0, 110)}`)
}
console.log(`  mean WER ${(tot / n * 100).toFixed(1)}%  RSS after ${rss()} MB`)
