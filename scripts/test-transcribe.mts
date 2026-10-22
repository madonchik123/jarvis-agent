import { Worker } from 'worker_threads'
import { join } from 'path'
const base = join(process.env.APPDATA!, 'Jarvis', 'models')
const w = new Worker(new URL('../src/main/speech/worker.ts', import.meta.url))
w.postMessage({ type: 'init', vad: join(base, 'vad/silero_vad.onnx'), wakeDir: join(base, 'wake/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16'), whisperDir: join(base, 'stt/sherpa-onnx-whisper-base'), whisperKind: 'base', gigaDir: join(base, 'stt/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16'), language: 'auto', aliases: ['джарвис'], sensitivity: 0.6, wakeEnabled: true, threads: 4 })
await new Promise((r) => w.once('message', r))
let id = 0
for (const f of process.argv.slice(2)) {
  const my = ++id
  w.postMessage({ type: 'transcribeFile', id: my, path: f })
  const m: any = await new Promise((r) => w.on('message', (x: any) => x.type === 'fileResult' && x.id === my && r(x)))
  console.log(f.split(/[\/]/).pop(), '=>', m.text, `[${m.lang}]`)
}
process.exit(0)
