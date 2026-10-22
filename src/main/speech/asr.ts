// Heavy speech recognisers (GigaAM-RU + Whisper) in a child process.
//
// Why a separate process: native model memory (~550 MB) is never handed back by a worker thread. A process that exits
// when idle returns every byte, and it can never block the always-on wake-word listener while it decodes.
//
// Protocol (Node IPC, "advanced" serialization so Float32Array crosses without copies):
//   parent → child  {type:'init', cfg}  |  {type:'job', id, samples, commandMode, gateHit, partial, aliases, sensitivity, language, wakeEnabled}
//   child  → parent {type:'ready'}      |  {type:'event', id, event}  |  {type:'done', id, produced}
import { stripWake, looseWakeGate, wakeThreshold, findWake } from '../../shared/textmatch'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sherpa = require('sherpa-onnx-node')

const SR = 16000
let cfg = { whisperDir: '', whisperKind: 'base', parakeetDir: '', gigaDir: '', threads: 4, language: '' }
let giga: any = null
let whisper: any = null
let parakeet: any = null

function getGiga(): any {
  if (!cfg.gigaDir) return null
  if (!giga) {
    giga = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 64 },
      modelConfig: { nemoCtc: { model: `${cfg.gigaDir}/model.int8.onnx` }, tokens: `${cfg.gigaDir}/tokens.txt`, numThreads: cfg.threads, provider: 'cpu', debug: false }
    })
  }
  return giga
}

function getParakeet(): any {
  if (!parakeet) {
    const d = cfg.parakeetDir
    parakeet = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` },
        tokens: `${d}/tokens.txt`,
        modelType: 'nemo_transducer',
        numThreads: cfg.threads,
        provider: 'cpu',
        debug: false
      }
    })
  }
  return parakeet
}

function getWhisper(): any {
  if (!whisper) {
    const dir = cfg.whisperDir
    const kind = cfg.whisperKind
    // With the Russian recogniser present Whisper only ever hears English: force it (no language-ID mistakes, faster).
    const lang = cfg.gigaDir ? 'en' : cfg.language
    whisper = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: `${dir}/${kind}-encoder.int8.onnx`, decoder: `${dir}/${kind}-decoder.int8.onnx`, language: lang, task: 'transcribe', tailPaddings: 800 },
        tokens: `${dir}/${kind}-tokens.txt`,
        numThreads: cfg.threads,
        provider: 'cpu',
        debug: false
      }
    })
  }
  return whisper
}

/** Quiet microphones are the #1 cause of bad recognition: bring the utterance to a healthy level (never clip). */
function normalizeGain(x: Float32Array): Float32Array {
  let peak = 0
  let mean = 0
  for (let i = 0; i < x.length; i++) mean += x[i]
  mean /= x.length || 1
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const v = x[i] - mean
    out[i] = v
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  if (peak > 0.004 && peak < 0.6) {
    const g = Math.min(0.7 / peak, 14)
    for (let i = 0; i < out.length; i++) out[i] *= g
  }
  return out
}

const countCyr = (t: string) => (t.match(/[а-яё]/gi) || []).length
const countLat = (t: string) => (t.match(/[a-z]/gi) || []).length
/** Russian result = mostly Cyrillic. (The Russian recogniser writes English speech as Latin transliteration.) */
const mostlyRussian = (t: string) => countCyr(t) >= 2 && countCyr(t) >= countLat(t)

function decode(rec: any, samples: Float32Array): string {
  const st = rec.createStream()
  st.acceptWaveform({ sampleRate: SR, samples })
  rec.decode(st)
  return (rec.getResult(st).text || '').trim()
}

const gigaText = (x: Float32Array) => {
  const g = getGiga()
  return g ? decode(g, x) : ''
}

/** English recogniser: Parakeet-TDT (fast, light, punctuated) when installed, otherwise Whisper. */
function whisperText(x: Float32Array): { text: string; lang: string } {
  if (cfg.parakeetDir) return { text: decode(getParakeet(), x), lang: 'en' }
  const w = getWhisper()
  const st = w.createStream()
  st.acceptWaveform({ sampleRate: SR, samples: x })
  w.decode(st)
  const r = w.getResult(st)
  return { text: (r.text || '').trim(), lang: String(r.lang || '').replace(/[<|>]/g, '') }
}

/** Russian recogniser first (fast, excellent); non-Russian output means English → Whisper. Settings can pin a language. */
function transcribe(x: Float32Array, language: string): { text: string; lang: string } {
  if (language !== 'en' && cfg.gigaDir) {
    const g = gigaText(x)
    if (language === 'ru' || mostlyRussian(g)) return { text: g, lang: 'ru' }
  }
  const w = whisperText(x)
  return { text: w.text, lang: w.lang === 'ru' ? 'ru' : 'en' }
}

interface Job {
  type: 'job'
  id: number
  samples: Float32Array
  commandMode: boolean
  gateHit: boolean
  partial: string
  aliases: string[]
  sensitivity: number
  language: string
}

function runJob(m: Job) {
  const emit = (event: any) => process.send!({ type: 'event', id: m.id, event })
  let produced = false
  try {
    const t0 = Date.now()
    const relaxed = wakeThreshold(m.sensitivity) - 0.08
    const x = normalizeGain(m.samples)
    let raw = ''
    let lang = ''
    let command = ''

    if (m.commandMode) {
      // waiting for a command: transcribe everything, no wake word needed
      emit({ type: 'busy', on: true })
      const tr = transcribe(x, m.language)
      raw = tr.text
      lang = tr.lang
      if (!raw) return
      const r = stripWake(raw, m.aliases, m.sensitivity, relaxed)
      command = r.hit ? r.command : raw
    } else {
      // Stage 1: Russian recogniser on every short utterance — finds the wake word even if the cheap gate misheard it.
      let verified = false
      let gigaLatin = ''
      if (m.language !== 'en' && cfg.gigaDir) {
        const g = gigaText(x)
        gigaLatin = g
        emit({ type: 'debug', giga: g, partial: m.partial })
        if (mostlyRussian(g)) {
          const r = stripWake(g, m.aliases, m.sensitivity, relaxed)
          // two independent recognisers vouching for the name is stronger than one: if the streaming gate heard it
          // clearly, accept it even when the big model wrote it badly ("Джарс"), and drop the mangled first word.
          const gateHeard = !r.hit && m.gateHit ? findWake(m.partial, m.aliases, m.sensitivity, 3, wakeThreshold(m.sensitivity) - 0.1) : null
          if (!r.hit && !gateHeard) {
            // Russian speech without the wake word: just conversation in the room — ignore.
            if (m.gateHit) emit({ type: 'wakeRejected', text: g })
            return
          }
          verified = true
          raw = g
          command = r.hit ? r.command : g.split(/\s+/).slice(Math.min(gateHeard!.consumed, 2)).join(' ').replace(/^[,.:;!?\s-]+/, '')
          lang = 'ru'
        }
      }
      // Stage 2: not Russian → English (or unclear). Whisper only if the gate thinks it heard the wake word.
      if (!verified) {
        if (m.language === 'ru') return
        // run the (heavier) English recogniser only when something resembling the name was heard by either model
        const maybeName = m.gateHit || looseWakeGate(m.partial, m.aliases) || (m.language !== 'ru' && looseWakeGate(gigaLatin, m.aliases))
        if (!maybeName) return
        emit({ type: 'busy', on: true })
        const w = whisperText(x)
        raw = w.text || m.partial
        lang = w.lang === 'ru' ? 'ru' : 'en'
        const r = stripWake(raw, m.aliases, m.sensitivity, relaxed)
        if (!r.hit) {
          emit({ type: 'wakeRejected', text: raw })
          return
        }
        command = r.command
      }
      if (!m.gateHit) emit({ type: 'wake', text: raw })
    }
    produced = true
    emit({ type: 'transcript', text: command.trim(), raw, woke: true, ms: Date.now() - t0, viaWake: !m.commandMode, lang })
  } catch (e: any) {
    emit({ type: 'error', error: String(e?.stack || e), soft: true })
  } finally {
    process.send!({ type: 'done', id: m.id, produced })
  }
}

process.on('message', (m: any) => {
  if (m.type === 'init') {
    cfg = m.cfg
    // start loading the Russian recogniser right away: the process is spawned the moment speech begins
    if (m.warm && cfg.gigaDir) {
      try {
        getGiga()
      } catch (e: any) {
        process.send!({ type: 'event', id: 0, event: { type: 'error', error: 'GigaAM failed to load: ' + String(e), soft: true } })
      }
    }
    process.send!({ type: 'ready' })
  } else if (m.type === 'job') {
    runJob(m)
  } else if (m.type === 'file') {
    // test hook: transcribe a wav path
    try {
      const wave = sherpa.readWave(m.path)
      const tr = transcribe(normalizeGain(wave.samples), cfg.language)
      process.send!({ type: 'fileResult', id: m.id, text: tr.text, lang: tr.lang })
    } catch (e: any) {
      process.send!({ type: 'fileResult', id: m.id, error: String(e) })
    }
  }
})

// the parent going away must never leave a 500 MB orphan behind
process.on('disconnect', () => process.exit(0))
