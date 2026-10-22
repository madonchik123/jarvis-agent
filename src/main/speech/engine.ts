import { Worker } from 'worker_threads'
import { fork, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Settings } from '../../shared/types'
import { pathsFor } from '../models'

export type SpeechEvent =
  | { type: 'ready' }
  | { type: 'error'; error: string; soft?: boolean }
  | { type: 'speech'; on: boolean }
  | { type: 'partial'; text: string }
  | { type: 'wake'; text: string }
  | { type: 'wakeRejected'; text: string }
  | { type: 'busy'; on: boolean }
  | { type: 'noResult' }
  | { type: 'mode'; mode: 'wake' | 'command'; timedOut?: boolean }
  | { type: 'transcript'; text: string; raw: string; woke: boolean; ms: number; viaWake: boolean; lang: string }

interface Job {
  id: number
  samples: Float32Array
  commandMode: boolean
  gateHit: boolean
  partial: string
}

/** The big recognisers exit after this long without work, returning ~550 MB to the OS. */
const CHILD_IDLE_MS = Number(process.env.JARVIS_ASR_IDLE_MS) || 120_000

/**
 * Two parts:
 *  - a worker thread with VAD + a tiny streaming wake gate (always on, ~200 MB)
 *  - an ASR child process (GigaAM-RU + Whisper) spawned when speech starts and killed when idle
 */
export class SpeechEngine extends EventEmitter {
  private worker: Worker | null = null
  private child: ChildProcess | null = null
  private childReady = false
  private childIdle: NodeJS.Timeout | null = null
  private queue: Job[] = []
  private inFlight: Job | null = null
  private produced = false
  private seq = 0
  ready = false

  constructor(
    private base: string,
    private getSettings: () => Settings
  ) {
    super()
  }

  missing(): string[] {
    const p = pathsFor(this.base)
    const s = this.getSettings()
    const miss: string[] = []
    if (!existsSync(p.vad)) miss.push('silero-vad')
    if (!p.wakeDir) miss.push('wake-ru-zipformer')
    // English recogniser: the chosen one, or any installed alternative
    const haveEn = existsSync(p.parakeetDir) || existsSync(p.whisperDir(whisperKind(s))) || existsSync(p.whisperDir('base'))
    if (!haveEn) miss.push('parakeet-en')
    return miss
  }

  private aliases() {
    const s = this.getSettings()
    const base = s.wakePhrases.map((x) => x.toLowerCase().trim()).filter(Boolean)
    // the recognisers write the default name many ways; accept the common ones without asking the user to list them
    const jarvis = ['джарвис', 'jarvis', 'жарвис'].some((a) => base.includes(a))
    const extra = jarvis ? ['джарви', 'джави', 'жарви', 'джарвиз', 'джервис', 'джарвес'] : []
    return Array.from(new Set([...base, ...extra]))
  }

  start() {
    if (this.worker || this.missing().length) return false
    const p = pathsFor(this.base)
    const s = this.getSettings()
    const w = new Worker(join(__dirname, 'speechWorker.js'))
    this.worker = w
    w.on('message', (m: any) => {
      if (m.type === 'ready') this.ready = true
      if (m.type === 'job') return this.enqueue(m)
      if (m.type === 'speech' && m.on) this.ensureChild() // warm the recognisers while the user is still talking
      this.emit('event', m)
    })
    w.on('error', (e) => this.emit('event', { type: 'error', error: String(e) }))
    w.on('exit', () => {
      this.worker = null
      this.ready = false
    })
    w.postMessage({ type: 'init', vad: p.vad, wakeDir: p.wakeDir, aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    return true
  }

  // ------------------------------------------------------------------ ASR child
  private childPath() {
    const f = join(__dirname, 'asrChild.js')
    const unpacked = f.replace('app.asar', 'app.asar.unpacked')
    return existsSync(unpacked) ? unpacked : f
  }

  private ensureChild() {
    this.armIdle()
    if (this.child) return
    const p = pathsFor(this.base)
    const s = this.getSettings()
    const c = fork(this.childPath(), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    this.child = c
    this.childReady = false
    c.stderr?.on('data', (d) => console.warn('[asr]', String(d).trim().slice(0, 300)))
    c.on('message', (m: any) => this.onChild(m))
    c.on('exit', () => {
      if (this.child === c) {
        this.child = null
        this.childReady = false
        if (this.inFlight) {
          // died mid-job: tell the UI so it never sits on "transcribing"
          this.inFlight = null
          this.emit('event', { type: 'busy', on: false })
          this.emit('event', { type: 'noResult' })
        }
        if (this.queue.length) this.ensureChild()
      }
    })
    c.send({
      type: 'init',
      warm: s.sttLanguage !== 'en',
      cfg: {
        whisperDir: existsSync(p.whisperDir(whisperKind(s))) ? p.whisperDir(whisperKind(s)) : p.whisperDir('base'),
        whisperKind: existsSync(p.whisperDir(whisperKind(s))) ? whisperKind(s) : 'base',
        parakeetDir: s.sttModel === 'parakeet-en' && existsSync(p.parakeetDir) ? p.parakeetDir : '',
        gigaDir: existsSync(p.gigaDir) ? p.gigaDir : '',
        threads: 4,
        language: s.sttLanguage === 'auto' ? '' : s.sttLanguage
      }
    })
  }

  private armIdle() {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = setTimeout(() => {
      if (this.inFlight || this.queue.length) return this.armIdle()
      this.killChild()
    }, CHILD_IDLE_MS)
  }

  private killChild() {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = null
    const c = this.child
    this.child = null
    this.childReady = false
    try {
      c?.kill()
    } catch {}
  }

  get asrLoaded() {
    return !!this.child
  }

  private enqueue(m: Omit<Job, 'id'>) {
    this.queue.push({ ...m, id: ++this.seq })
    this.ensureChild()
    this.pump()
  }

  private pump() {
    if (this.inFlight || !this.child || !this.childReady) return
    const job = this.queue.shift()
    if (!job) return
    this.inFlight = job
    this.produced = false
    const s = this.getSettings()
    this.child.send({
      type: 'job',
      id: job.id,
      samples: job.samples,
      commandMode: job.commandMode,
      gateHit: job.gateHit,
      partial: job.partial,
      aliases: this.aliases(),
      sensitivity: s.wakeSensitivity,
      language: s.sttLanguage === 'auto' ? '' : s.sttLanguage
    })
  }

  private onChild(m: any) {
    if (m.type === 'ready') {
      this.childReady = true
      this.pump()
    } else if (m.type === 'event') {
      if (m.event.type === 'transcript') {
        this.produced = true
        // A command we were waiting for has been consumed: leave command mode BEFORE the consumer sees the transcript,
        // so it can open a new listening window (wake-only "Джарвис" → "Да, сэр?" → listen) without us cancelling it.
        if (this.inFlight?.commandMode) this.worker?.postMessage({ type: 'mode', mode: 'wake', silent: true })
        // Wake-only ("Джарвис" + pause): the recogniser process may still have been cold-starting, so the user's actual
        // command can already be queued behind this job. It is a command, not room chatter.
        if (this.inFlight && !this.inFlight.commandMode && !String(m.event.text || '').trim()) {
          for (const j of this.queue) j.commandMode = true
        }
      }
      this.emit('event', m.event)
    } else if (m.type === 'done') {
      const wasProduced = this.produced
      this.inFlight = null
      this.emit('event', { type: 'busy', on: false })
      if (!wasProduced) this.emit('event', { type: 'noResult' })
      this.armIdle()
      this.pump()
    }
  }

  // ------------------------------------------------------------------ controls
  feed(buf: ArrayBuffer) {
    if (!this.worker || !this.ready) return
    const samples = new Float32Array(buf)
    this.worker.postMessage({ type: 'audio', samples }, [samples.buffer])
  }

  listenFor(seconds: number) {
    this.worker?.postMessage({ type: 'mode', mode: 'command', timeoutMs: seconds * 1000 })
  }

  cancelListen() {
    this.worker?.postMessage({ type: 'mode', mode: 'wake' })
  }

  speaking(on: boolean) {
    this.worker?.postMessage({ type: 'speaking', on })
  }

  updateConfig() {
    const s = this.getSettings()
    this.worker?.postMessage({ type: 'config', aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    this.killChild() // language / model choice changed: the next utterance starts a fresh child with the new settings
  }

  restart() {
    this.dispose()
    return this.start()
  }

  dispose() {
    this.killChild()
    void this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.queue = []
    this.inFlight = null
  }
}

/** which Whisper size to use when Whisper is the chosen (or fallback) English engine */
function whisperKind(s: Settings): 'base' | 'small' | 'turbo' {
  return s.sttModel.startsWith('whisper-') ? (s.sttModel.replace('whisper-', '') as 'base' | 'small' | 'turbo') : 'base'
}
