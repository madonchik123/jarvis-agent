// STT benchmark on Fish-synthesised speech (needs the Fish key in the Jarvis settings):
//   npx tsx scripts/bench-stt.mts <dir with extracted sherpa models>
// Compares GigaAM v3 CTC / RNNT and Parakeet (v3 multilingual, 110M EN) on Russian, English and mixed phrases:
// word error rate and decode time.
import { readFileSync, writeFileSync, mkdirSync, existsSync, writeSync } from 'node:fs'
const log = (...a: unknown[]) => writeSync(1, a.join(' ') + '\n')
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const CASES: { lang: 'ru' | 'en'; kind: string; text: string }[] = [
  { lang: 'ru', kind: 'ru', text: 'Джарвис, открой калькулятор и посчитай двенадцать умножить на семь.' },
  { lang: 'ru', kind: 'ru', text: 'Сделай потише музыку и поставь следующий трек.' },
  { lang: 'ru', kind: 'ru', text: 'Какая завтра погода в Москве и нужно ли брать зонт?' },
  { lang: 'ru', kind: 'ru', text: 'Напомни мне через двадцать минут выключить духовку.' },
  { lang: 'ru', kind: 'long', text: 'Найди в интернете три лучших ноутбука для программирования до ста тысяч рублей, сравни их по экрану, процессору и времени работы от батареи, и коротко расскажи, какой из них ты бы выбрал для меня и почему.' },
  { lang: 'ru', kind: 'long', text: 'Открой браузер, зайди на страницу с моими заказами, найди последнюю доставку, скопируй номер отслеживания и отправь его Андрею в телеграме с подписью, что посылка уже в пути и приедет в пятницу.' },
  { lang: 'ru', kind: 'mixed', text: 'Открой Spotify и включи плейлист Daft Punk.' },
  { lang: 'ru', kind: 'mixed', text: 'Запусти Visual Studio Code и создай новый файл index.html.' },
  { lang: 'ru', kind: 'mixed', text: 'Напиши в Discord сообщение: hello everyone, meeting at five.' },
  { lang: 'ru', kind: 'mixed', text: 'Зайди на YouTube и найди обзор на iPhone пятнадцать.' },
  { lang: 'en', kind: 'en', text: 'Jarvis, open the calculator and multiply twelve by seven.' },
  { lang: 'en', kind: 'en', text: 'Turn the volume down a little and skip to the next track.' },
  { lang: 'en', kind: 'en', text: 'What is the weather like tomorrow in London, and should I take an umbrella?' },
  { lang: 'en', kind: 'long', text: 'Search the web for the three best laptops for programming under fifteen hundred dollars, compare their screens, processors and battery life, and tell me briefly which one you would pick for me and why.' },
  { lang: 'en', kind: 'long', text: 'Open the browser, go to my orders page, find the latest delivery, copy the tracking number and send it to Andrew on Telegram saying the parcel is on its way and will arrive on Friday.' }
]

const dir = process.argv[2]
const audio = join(dir, 'bench-audio')
mkdirSync(audio, { recursive: true })
const settings = JSON.parse(readFileSync(join(process.env.APPDATA!, 'Jarvis', 'settings.json'), 'utf8'))

async function synth(i: number, c: (typeof CASES)[number]): Promise<Float32Array> {
  const f = join(audio, `${i}.wav`)
  if (!existsSync(f)) {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.fishApiKey}`, 'content-type': 'application/json', model: 's2.1-pro-free' },
      body: JSON.stringify({ text: c.text, reference_id: c.lang === 'ru' ? settings.fishVoiceRu : settings.fishVoiceEn, format: 'wav', sample_rate: 16000, normalize: true })
    })
    if (!res.ok) throw new Error('fish ' + res.status)
    writeFileSync(f, Buffer.from(await res.arrayBuffer()))
  }
  // minimal PCM16 reader (Fish streams WAV with an unknown data size, which crashes sherpa.readWave)
  const buf = readFileSync(f)
  let pos = 12
  let dataAt = -1
  let rate = 16000
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(pos + 12)
    if (id === 'data') { dataAt = pos + 8; break }
    pos += 8 + size
  }
  const n = Math.floor((buf.length - dataAt) / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataAt + i * 2) / 32768
  if (rate !== 16000) throw new Error('unexpected sample rate ' + rate)
  return out
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
function wer(ref: string[], hyp: string[]) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)])
  for (let j = 0; j <= hyp.length; j++) d[0][j] = j
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
  return d[ref.length][hyp.length]
}

const find = (re: RegExp) => {
  const { readdirSync } = require('node:fs')
  return readdirSync(dir).find((n: string) => re.test(n))
}
const models: Record<string, () => any> = {}
const gigaCtc = find(/ctc-punct-giga-am-v3/)
const gigaRnnt = find(/transducer-punct-giga-am-v3/)
const pk3 = find(/parakeet-tdt-0.6b-v3/)
const pk110 = find(/parakeet_tdt_transducer_110m/)
const tr = (d: string, ext = '.int8') => ({ encoder: join(dir, d, `encoder${ext}.onnx`), decoder: join(dir, d, `decoder${ext}.onnx`), joiner: join(dir, d, `joiner${ext}.onnx`) })
if (gigaCtc) models['giga-v3-ctc'] = () => new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 64 }, modelConfig: { nemoCtc: { model: join(dir, gigaCtc, 'model.int8.onnx') }, tokens: join(dir, gigaCtc, 'tokens.txt'), numThreads: 4, provider: 'cpu' } })
if (gigaRnnt) models['giga-v3-rnnt'] = () => new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 64 }, modelConfig: { transducer: { encoder: join(dir, gigaRnnt, 'encoder.int8.onnx'), decoder: join(dir, gigaRnnt, 'decoder.onnx'), joiner: join(dir, gigaRnnt, 'joiner.onnx') }, tokens: join(dir, gigaRnnt, 'tokens.txt'), modelType: 'nemo_transducer', numThreads: 4, provider: 'cpu' } })
if (pk3) models['parakeet-v3'] = () => new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 128 }, modelConfig: { transducer: tr(pk3), tokens: join(dir, pk3, 'tokens.txt'), modelType: 'nemo_transducer', numThreads: 4, provider: 'cpu' } })
if (pk110) models['parakeet-110m'] = () => new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: tr(pk110), tokens: join(dir, pk110, 'tokens.txt'), modelType: 'nemo_transducer', numThreads: 4, provider: 'cpu' } })

const wavs: Float32Array[] = []
for (let i = 0; i < CASES.length; i++) wavs.push(await synth(i, CASES[i]))

log('audio ready,', Object.keys(models).join(', '))
for (const [name, make] of Object.entries(models)) {
  log('loading', name)
  const t0 = Date.now()
  const rec = make()
  const loadMs = Date.now() - t0
  const agg: Record<string, { err: number; words: number; ms: number; secs: number }> = {}
  const show: string[] = []
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]
    const x = wavs[i]
    const t1 = Date.now()
    const st = rec.createStream()
    st.acceptWaveform({ sampleRate: 16000, samples: x })
    rec.decode(st)
    const hyp = String(rec.getResult(st).text || '').trim()
    const ms = Date.now() - t1
    const ref = norm(c.text)
    const e = wer(ref, norm(hyp))
    const key = `${c.lang}/${c.kind}`
    const a = (agg[key] ??= { err: 0, words: 0, ms: 0, secs: 0 })
    a.err += e
    a.words += ref.length
    a.ms += ms
    a.secs += x.length / 16000
    if (e > 0 && show.length < 5) show.push(`   ✗ ${key}: ${hyp}`)
  }
  log(`\n== ${name}  (load ${loadMs} ms)`)
  for (const [k, a] of Object.entries(agg)) log(`   ${k.padEnd(10)} WER ${((a.err / a.words) * 100).toFixed(1).padStart(5)}%   decode ${Math.round(a.ms / (a.secs || 1))} ms per audio second`)
  log(show.join('\n'))
}
