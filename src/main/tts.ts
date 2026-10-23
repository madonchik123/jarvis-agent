import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { EventEmitter } from 'events'
import type { XttsSidecar } from './xtts'
import { fishSynth, serverSynth, type FishConfig } from './fish'

/**
 * Persistent Piper processes (one per voice). Piper in --json-input mode reads a JSON line per
 * utterance and writes the path of the generated wav to stdout, so the model is loaded only once.
 */
class PiperVoice {
  private proc: ChildProcessWithoutNullStreams | null = null
  private queue: { resolve: (p: string) => void; reject: (e: Error) => void }[] = []
  private buf = ''
  private outDir: string

  constructor(
    private exe: string,
    private model: string,
    tmpRoot: string,
    readonly id: string
  ) {
    this.outDir = join(tmpRoot, id)
    mkdirSync(this.outDir, { recursive: true })
  }

  private start() {
    const p = spawn(
      this.exe,
      ['--model', this.model, '--json-input', '--output_dir', this.outDir, '--quiet'],
      { cwd: dirname(this.exe), windowsHide: true }
    )
    p.stdout.on('data', (d) => {
      this.buf += d.toString()
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        const job = this.queue.shift()
        job?.resolve(line)
      }
    })
    p.stderr.on('data', () => {})
    p.on('exit', () => {
      this.proc = null
      for (const j of this.queue.splice(0)) j.reject(new Error('piper exited'))
    })
    this.proc = p
  }

  synth(text: string, lengthScale: number): Promise<string> {
    if (!this.proc) this.start()
    return new Promise((resolve, reject) => {
      // Piper prints nothing for input it cannot speak; without a timeout the whole queue would stall forever.
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((j) => j.resolve === done)
        if (i >= 0) this.queue.splice(i, 1)
        this.dispose()
        reject(new Error('piper timeout'))
      }, 15000)
      const done = (p: string) => {
        clearTimeout(timer)
        resolve(p)
      }
      this.queue.push({ resolve: done, reject: (e) => (clearTimeout(timer), reject(e)) })
      this.proc!.stdin.write(JSON.stringify({ text, length_scale: lengthScale }) + '\n')
    })
  }

  dispose() {
    try {
      this.proc?.kill()
    } catch {}
    this.proc = null
  }
}

export interface SpeakRequest {
  id: string
  text: string
  lang: 'ru' | 'en'
  voice: string
  speed: number
}

export class Tts extends EventEmitter {
  private voices = new Map<string, PiperVoice>()

  constructor(
    private paths: { piperExe: string; voice: (id: string) => string },
    private tmpRoot: string,
    private xtts?: XttsSidecar,
    private fish?: () => FishConfig
  ) {
    super()
    rmSync(tmpRoot, { recursive: true, force: true })
    mkdirSync(tmpRoot, { recursive: true })
  }

  available(voiceId: string) {
    if (voiceId.startsWith('fish:')) {
      const f = this.fish?.()
      if (!f || f.mode === 'local') return false
      if (f.mode === 'server') return !!f.serverUrl
      return !!f.apiKey && !!(voiceId === 'fish:en' ? f.voiceEn : f.voiceRu)
    }
    if (voiceId.startsWith('xtts:')) return !!this.xtts?.available()
    return existsSync(this.paths.piperExe) && existsSync(this.paths.voice(voiceId))
  }

  /** Synthesise one sentence → returns audio bytes (wav, or mp3 from the free server). */
  async synth(text: string, voiceId: string, speed = 1, lang: 'ru' | 'en' = 'ru'): Promise<Buffer> {
    if (voiceId.startsWith('fish:')) {
      const f = this.fish!()
      const l = voiceId === 'fish:en' ? 'en' : 'ru'
      return f.mode === 'server' ? serverSynth(f, text, l, speed) : fishSynth(f, text, l, speed)
    }
    if (voiceId.startsWith('xtts:')) return this.xtts!.synth(text, lang, speed)
    let v = this.voices.get(voiceId)
    if (!v) {
      v = new PiperVoice(this.paths.piperExe, this.paths.voice(voiceId), this.tmpRoot, voiceId)
      this.voices.set(voiceId, v)
    }
    const lengthScale = Math.min(2, Math.max(0.5, 1 / speed))
    const file = await v.synth(text, lengthScale)
    const buf = readFileSync(file)
    rmSync(file, { force: true })
    return buf
  }

  warm(voiceId: string) {
    if (voiceId.startsWith('fish:')) return // cloud: nothing to load
    if (voiceId.startsWith('xtts:')) {
      if (this.available(voiceId)) void this.xtts!.ensure().catch(() => {})
      return
    }
    if (this.available(voiceId)) void this.synth('.', voiceId).catch(() => {})
  }

  dispose() {
    for (const v of this.voices.values()) v.dispose()
    this.voices.clear()
  }
}

/** Split text into speakable sentences so playback can start after the first one is ready. */
export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const parts = clean.match(/[^.!?…]+[.!?…]*\s*/g) || [clean]
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    cur += p
    if (cur.length >= 24) {
      out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) {
    if (out.length && cur.length < 24) out[out.length - 1] += ' ' + cur.trim()
    else out.push(cur.trim())
  }
  return out
}

/** Strip everything a speech engine should not read: markdown, URLs, emoji, code, newlines. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#>~|\[\]{}<>\\]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectLang(text: string): 'ru' | 'en' {
  const cyr = (text.match(/[а-яё]/gi) || []).length
  const lat = (text.match(/[a-z]/gi) || []).length
  return cyr >= lat ? 'ru' : 'en'
}
