// Does GigaAM degrade on long audio?  node --import tsx scripts/bench-long.mts <models dir with bench-audio from bench-stt>
import { readFileSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const log = (...a: unknown[]) => writeSync(1, a.join(' ') + '\n')
const dir = process.argv[2]
const gd = join(dir, readdirSync(dir).find((n) => /ctc-punct-giga-am-v3/.test(n))!)
const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 64 }, modelConfig: { nemoCtc: { model: join(gd, 'model.int8.onnx') }, tokens: join(gd, 'tokens.txt'), numThreads: 4, provider: 'cpu' } })
const read = (i: number) => {
  const buf = readFileSync(join(dir, 'bench-audio', `${i}.wav`))
  let pos = 12
  while (buf.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + buf.readUInt32LE(pos + 4)
  const at = pos + 8
  const n = Math.floor((buf.length - at) / 2)
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) o[i] = buf.readInt16LE(at + i * 2) / 32768
  return o
}
const gap = new Float32Array(16000 * 0.6)
const clips = [4, 5, 0, 1, 2, 3, 4, 5].map(read)
const parts: Float32Array[] = []
for (const c of clips) parts.push(c, gap)
const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
let o = 0
for (const p of parts) { all.set(p, o); o += p.length }
const dec = (x: Float32Array) => {
  const t0 = Date.now()
  const st = rec.createStream()
  st.acceptWaveform({ sampleRate: 16000, samples: x })
  rec.decode(st)
  return { text: String(rec.getResult(st).text || '').trim(), ms: Date.now() - t0 }
}
const whole = dec(all)
let chunked = ''
let cms = 0
for (const c of clips) { const r = dec(c); chunked += ' ' + r.text; cms += r.ms }
log('audio', (all.length / 16000).toFixed(1), 's')
log('whole  ', whole.ms, 'ms,', whole.text.split(/\s+/).length, 'words')
log('chunked', cms, 'ms,', chunked.trim().split(/\s+/).length, 'words')
const w = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean))
const A = w(whole.text), B = w(chunked)
let inter = 0
for (const x of A) if (B.has(x)) inter++
log('vocabulary overlap whole vs chunked', Math.round((inter / Math.max(A.size, B.size)) * 100) + '%')
log('whole tail:', whole.text.slice(-200))
log('chunk tail:', chunked.trim().slice(-200))
