import { Worker } from 'worker_threads'
import { readFileSync } from 'fs'
import { join } from 'path'

const base = join(process.env.APPDATA!, 'Jarvis', 'models')
const wavs = process.argv.slice(2)
function readWav16k(p: string): Float32Array {
  const b = readFileSync(p)
  const sr = b.readUInt32LE(24)
  const data = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)))
  const out = new Float32Array(Math.floor((data.length * 16000) / sr))
  for (let i = 0; i < out.length; i++) out[i] = data[Math.floor((i * sr) / 16000)] / 32768
  return out
}
const w = new Worker(new URL('../src/main/speech/worker.ts', import.meta.url))
w.on('message', (m) => { if (m.type !== 'partial') console.log(JSON.stringify(m)) ; else console.log('  partial:', m.text) })
w.on('error', (e) => console.error('worker error', e))
w.postMessage({ type: 'init', vad: join(base, 'vad/silero_vad.onnx'), wakeDir: join(base, 'wake/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16'), whisperDir: join(base, 'stt/sherpa-onnx-whisper-base'), whisperKind: 'base', gigaDir: join(base, 'stt/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16'), language: 'auto', aliases: ['джарвис', 'jarvis'], sensitivity: 0.6, wakeEnabled: true, threads: 4 })
await new Promise((r) => w.once('message', r))
const rss = (l: string) => console.log('RSS', l, Math.round(process.memoryUsage().rss / 1048576), 'MB')
rss('after init (VAD + wake gate only)')
for (const f of wavs) {
  console.log('=== feeding', f)
  const pcm = readWav16k(f)
  const sil = new Float32Array(16000 * 1)
  const all = new Float32Array(sil.length * 2 + pcm.length)
  all.set(pcm, sil.length)
  for (let o = 0; o < all.length; o += 1600) {
    w.postMessage({ type: 'audio', samples: all.slice(o, o + 1600) })
    await new Promise((r) => setTimeout(r, 5))
  }
  await new Promise((r) => setTimeout(r, 4000))
  rss('after ' + f.split(/[\/]/).pop())
}
await new Promise((r) => setTimeout(r, 9000))
rss('after idle unload')
process.exit(0)
