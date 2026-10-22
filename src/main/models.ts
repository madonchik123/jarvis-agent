import { createWriteStream, existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ModelAsset, SetupProgress } from '../shared/types'

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
const HF_JARVIS = 'https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis'

interface Def {
  id: string
  name: string
  kind: ModelAsset['kind']
  sizeMB: number
  required: boolean
  note?: string
  /** folder (relative to models dir) that must exist to count as installed */
  check: string
  files?: { url: string; dest: string }[]
  archive?: { url: string; type: 'tar' | 'zip'; into: string; stripTop?: boolean }
}

const piper = (lang: string, region: string, speaker: string, quality: string, sizeMB: number, name: string): Def => {
  const id = `${lang}_${region}-${speaker}-${quality}`
  const base = `${HF_PIPER}/${lang}/${lang}_${region}/${speaker}/${quality}/${id}`
  return {
    id,
    name,
    kind: 'tts',
    sizeMB,
    required: false,
    check: `tts/voices/${id}.onnx`,
    files: [
      { url: `${base}.onnx`, dest: `tts/voices/${id}.onnx` },
      { url: `${base}.onnx.json`, dest: `tts/voices/${id}.onnx.json` }
    ]
  }
}

export const CATALOG: Def[] = [
  {
    id: 'silero-vad',
    name: 'Silero VAD',
    kind: 'vad',
    sizeMB: 1,
    required: true,
    check: 'vad/silero_vad.onnx',
    files: [{ url: `${GH}/silero_vad.onnx`, dest: 'vad/silero_vad.onnx' }]
  },
  {
    id: 'wake-ru-zipformer',
    name: 'Wake-word listener (streaming RU zipformer)',
    kind: 'wake',
    sizeMB: 23,
    required: true,
    note: 'Always-on, runs only while someone is talking',
    check: 'wake/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16',
    archive: { url: `${GH}/sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16.tar.bz2`, type: 'tar', into: 'wake' }
  },
  {
    id: 'whisper-base',
    name: 'Whisper base (fallback English)',
    kind: 'stt',
    sizeMB: 198,
    required: false,
    check: 'stt/sherpa-onnx-whisper-base',
    archive: { url: `${GH}/sherpa-onnx-whisper-base.tar.bz2`, type: 'tar', into: 'stt' }
  },
  {
    id: 'gigaam-ru',
    name: 'GigaAM v3 Russian (best Russian accuracy)',
    kind: 'stt',
    sizeMB: 156,
    required: true,
    note: 'Used automatically when Whisper detects Russian',
    check: 'stt/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16',
    archive: { url: `${GH}/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16.tar.bz2`, type: 'tar', into: 'stt' }
  },
  {
    id: 'parakeet-en',
    name: 'Parakeet-TDT 110M (English, light + accurate)',
    kind: 'stt',
    sizeMB: 108,
    required: true,
    note: 'English recogniser: 3x faster and lighter than Whisper',
    check: 'stt/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
    archive: { url: `${GH}/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2`, type: 'tar', into: 'stt' }
  },
  {
    id: 'whisper-small',
    name: 'Whisper small (accurate)',
    kind: 'stt',
    sizeMB: 610,
    required: false,
    check: 'stt/sherpa-onnx-whisper-small',
    archive: { url: `${GH}/sherpa-onnx-whisper-small.tar.bz2`, type: 'tar', into: 'stt' }
  },
  {
    id: 'whisper-turbo',
    name: 'Whisper turbo (best, slower)',
    kind: 'stt',
    sizeMB: 538,
    required: false,
    check: 'stt/sherpa-onnx-whisper-turbo',
    archive: { url: `${GH}/sherpa-onnx-whisper-turbo.tar.bz2`, type: 'tar', into: 'stt' }
  },
  {
    id: 'piper-runtime',
    name: 'Piper speech engine',
    kind: 'tts',
    sizeMB: 22,
    required: true,
    check: 'tts/piper/piper.exe',
    archive: { url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', type: 'zip', into: 'tts' }
  },
  {
    id: 'jarvis-high',
    name: 'Jarvis (MCU-style, English) — high',
    kind: 'tts',
    sizeMB: 110,
    required: true,
    note: 'Community Piper model emulating the film voice',
    check: 'tts/voices/jarvis-high.onnx',
    files: [
      { url: `${HF_JARVIS}/high/jarvis-high.onnx`, dest: 'tts/voices/jarvis-high.onnx' },
      { url: `${HF_JARVIS}/high/jarvis-high.onnx.json`, dest: 'tts/voices/jarvis-high.onnx.json' }
    ]
  },
  {
    id: 'jarvis-medium',
    name: 'Jarvis (MCU-style, English) — medium (lighter)',
    kind: 'tts',
    sizeMB: 62,
    required: false,
    check: 'tts/voices/jarvis-medium.onnx',
    files: [
      { url: `${HF_JARVIS}/medium/jarvis-medium.onnx`, dest: 'tts/voices/jarvis-medium.onnx' },
      { url: `${HF_JARVIS}/medium/jarvis-medium.onnx.json`, dest: 'tts/voices/jarvis-medium.onnx.json' }
    ]
  },
  { ...piper('ru', 'RU', 'denis', 'medium', 63, 'Русский — Денис (deep male)'), required: true },
  piper('ru', 'RU', 'dmitri', 'medium', 63, 'Русский — Дмитрий'),
  piper('ru', 'RU', 'ruslan', 'medium', 63, 'Русский — Руслан'),
  piper('ru', 'RU', 'irina', 'medium', 63, 'Русский — Ирина')
]

export function modelsDir(base: string) {
  return join(base, 'models')
}

export function listAssets(base: string): ModelAsset[] {
  const dir = modelsDir(base)
  return CATALOG.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    sizeMB: d.sizeMB,
    required: d.required,
    note: d.note,
    installed: existsSync(join(dir, d.check))
  }))
}

async function download(url: string, dest: string, onProgress: (received: number, total: number) => void) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = dest + '.part'
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const src = Readable.fromWeb(res.body as any)
  src.on('data', (c: Buffer) => {
    received += c.length
    onProgress(received, total)
  })
  await pipeline(src, createWriteStream(tmp))
  renameSync(tmp, dest)
}

function extract(archive: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  return new Promise((resolve, reject) => {
    // Windows 10+ ships bsdtar which handles .tar.bz2 and .zip
    const tarExe = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar'
    const p = spawn(tarExe, ['-xf', archive, '-C', outDir], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err}`))))
    p.on('error', reject)
  })
}

export async function installAsset(base: string, id: string, onProgress: (p: SetupProgress) => void) {
  const def = CATALOG.find((d) => d.id === id)
  if (!def) throw new Error('Unknown asset ' + id)
  const dir = modelsDir(base)
  try {
    if (def.files) {
      const sizes = def.files.map(() => 0)
      const totals = def.files.map(() => 0)
      for (let i = 0; i < def.files.length; i++) {
        const f = def.files[i]
        await download(f.url, join(dir, f.dest), (r, t) => {
          sizes[i] = r
          totals[i] = t
          const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
          onProgress({ id, phase: 'downloading', received: sum(sizes), total: Math.max(sum(totals), def.sizeMB * 1024 * 1024 * 0.98) })
        })
      }
    } else if (def.archive) {
      const tmp = join(dir, '_downloads', `${id}.${def.archive.type === 'zip' ? 'zip' : 'tar.bz2'}`)
      await download(def.archive.url, tmp, (r, t) => onProgress({ id, phase: 'downloading', received: r, total: t }))
      onProgress({ id, phase: 'extracting', received: 1, total: 1 })
      await extract(tmp, join(dir, def.archive.into))
      rmSync(tmp, { force: true })
    }
    onProgress({ id, phase: 'done', received: 1, total: 1 })
  } catch (e: any) {
    onProgress({ id, phase: 'error', received: 0, total: 0, error: String(e?.message || e) })
    throw e
  }
}

export function pathsFor(base: string) {
  const dir = modelsDir(base)
  const sub = (p: string) => join(dir, p)
  const firstDir = (parent: string, prefix: string) => {
    try {
      const n = readdirSync(parent).find((x) => x.startsWith(prefix) && statSync(join(parent, x)).isDirectory())
      return n ? join(parent, n) : ''
    } catch {
      return ''
    }
  }
  return {
    vad: sub('vad/silero_vad.onnx'),
    wakeDir: firstDir(sub('wake'), 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8'),
    gigaDir: sub('stt/sherpa-onnx-nemo-ctc-punct-giga-am-v3-russian-2025-12-16'),
    whisperDir: (kind: 'base' | 'small' | 'turbo') => sub(`stt/sherpa-onnx-whisper-${kind}`),
    parakeetDir: sub('stt/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8'),
    piperExe: sub('tts/piper/piper.exe'),
    voice: (id: string) => sub(`tts/voices/${id}.onnx`)
  }
}
