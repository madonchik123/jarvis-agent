import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

export interface WinWindow {
  hwnd: number
  title: string
  process: string
  x: number
  y: number
  w: number
  h: number
  focused: boolean
  minimized: boolean
}
export interface UiaElement {
  id: string
  type: string
  name: string
  auto: string
  x: number
  y: number
  w: number
  h: number
  enabled: boolean
  value?: string
  depth?: number
}
export interface OcrWord {
  t: string
  x: number
  y: number
  w: number
  h: number
}
export interface OcrLine {
  text: string
  x: number
  y: number
  w: number
  h: number
  words: OcrWord[]
}
export interface OcrResult {
  lang: string
  text: string
  lines: OcrLine[]
}

const scriptPath = () => (app.isPackaged ? join(process.resourcesPath, 'bridge.ps1') : join(app.getAppPath(), 'resources', 'bridge.ps1'))

/** jarvis-native.exe (C#, .NET Framework 4.8 — part of Windows): the computer-use engine. bridge.ps1 is the fallback. */
export const nativePath = () => (app.isPackaged ? join(process.resourcesPath, 'native', 'jarvis-native.exe') : join(app.getAppPath(), 'resources', 'native', 'jarvis-native.exe'))
export const hasNative = () => existsSync(nativePath())

/** Persistent helper process exposing mouse/keyboard/UIA/OCR/screenshot and window-state primitives (JSON lines). */
export class WinBridge {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private seq = 0
  private ready: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  /** each bridge is a ~100 MB PowerShell: stop it when unused, it restarts on the next call */
  constructor(private idleMs = 90_000) {}

  private start() {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const p = hasNative()
        ? spawn(nativePath(), [], { windowsHide: true })
        : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], { windowsHide: true })
      this.proc = p
      const rl = createInterface({ input: p.stdout })
      rl.on('line', (line) => {
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          return
        }
        if (m.id === 0) return resolve()
        const job = this.pending.get(m.id)
        if (!job) return
        clearTimeout(job.timer)
        this.pending.delete(m.id)
        m.ok ? job.resolve(m.result) : job.reject(new Error(m.error))
      })
      p.stderr.on('data', (d) => console.warn('[bridge]', d.toString().trim()))
      p.on('exit', () => {
        this.proc = null
        this.ready = null
        for (const j of this.pending.values()) {
          clearTimeout(j.timer)
          j.reject(new Error('bridge exited'))
        }
        this.pending.clear()
      })
      setTimeout(() => reject(new Error('bridge start timeout')), 20000)
    })
    return this.ready
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.idleMs) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size) return this.armIdle()
      this.dispose()
    }, this.idleMs)
  }

  async call<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    this.armIdle()
    await this.start()
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge ${cmd} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }

  warm() {
    void this.start().catch(() => {})
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    try {
      this.proc?.kill()
    } catch {}
  }
}
