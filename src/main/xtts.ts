import { spawn, spawnSync, ChildProcess } from 'child_process'
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import { app } from 'electron'
import { EventEmitter } from 'events'
import { dataDir } from './store'

export type CloneState = 'off' | 'starting' | 'ready' | 'error'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

/**
 * Optional GPU voice-cloning engine (XTTS-v2) running as a Python sidecar. It speaks in the voice of the user's own
 * reference clips (Russian *and* English). Layout, first match wins:
 *   <userData>/clone/{venv, xtts_server.py, refs}      — installed copy
 *   <app>/voice/{.venv, xtts_server.py, dataset}       — development checkout
 */
export class XttsSidecar extends EventEmitter {
  state: CloneState = 'off'
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<void> | null = null
  lastError = ''
  lastUsed = Date.now()
  private idleTimer: NodeJS.Timeout | null = null
  idleMinutes = 10

  paths() {
    const user = join(dataDir(), 'clone')
    const dev = join(app.getAppPath(), 'voice')
    const pick = (a: string, b: string) => (existsSync(a) ? a : b)
    return {
      python: pick(join(user, 'venv', 'Scripts', 'python.exe'), join(dev, '.venv', 'Scripts', 'python.exe')),
      script: pick(join(user, 'xtts_server.py'), join(dev, 'xtts_server.py')),
      refs: pick(join(user, 'refs'), join(dev, 'dataset'))
    }
  }

  available(): boolean {
    const p = this.paths()
    try {
      return existsSync(p.python) && existsSync(p.script) && existsSync(p.refs) && readdirSync(p.refs).some((f) => f.endsWith('.wav'))
    } catch {
      return false
    }
  }

  /** Kill engines left over from a previous (crashed / force-closed) run — they would hold the GPU memory. */
  private killStale() {
    try {
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'xtts_server\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
        { windowsHide: true, timeout: 8000 }
      )
    } catch {}
  }

  private set(state: CloneState) {
    this.state = state
    this.emit('state', state)
  }

  ensure(): Promise<void> {
    this.lastUsed = Date.now()
    if (this.state === 'ready' && this.proc) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private async start() {
    if (!this.available()) throw new Error('voice clone is not installed')
    this.set('starting')
    this.lastError = ''
    this.port = await freePort()
    const p = this.paths()
    this.killStale()
    const proc = spawn(p.python, [p.script, '--refs', p.refs, '--port', String(this.port), '--eq', '0.5', '--parent', String(process.pid)], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    this.proc = proc
    let log = ''
    const logFile = join(dataDir(), 'clone.log')
    try {
      writeFileSync(logFile, `# ${new Date().toISOString()} ${p.python} ${p.script} --refs ${p.refs} --port ${this.port}\n`)
    } catch {}
    const onData = (d: Buffer) => {
      log = (log + d.toString()).slice(-6000)
      try {
        appendFileSync(logFile, d)
      } catch {}
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (e) => {
      log += String(e)
    })
    // 'close' fires after the stdio streams are drained, so the log really contains the failure reason
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null
      if (this.state !== 'off' && this.state !== 'ready') {
        const tail = log.split('\n').map((l) => l.trim()).filter((l) => l && !/FutureWarning|weights_only|torch\.load/.test(l)).slice(-4).join(' | ')
        this.lastError = `exit code ${code}: ${tail || 'no output'} (see ${logFile})`
        this.set('error')
      } else if (this.state === 'ready') {
        this.lastError = `engine stopped (code ${code})`
        this.set('error')
      }
    })
    const t0 = Date.now()
    while (Date.now() - t0 < 240_000) {
      if (!this.proc) {
        await new Promise((r) => setTimeout(r, 300)) // let the 'close' handler fill lastError
        throw new Error('clone engine exited: ' + this.lastError)
      }
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) {
          this.set('ready')
          this.armIdle()
          return
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.stop()
    throw new Error('clone engine start timeout')
  }

  /** Free ~1.7 GB RAM + ~4.5 GB VRAM when the voice has not been used for a while (it reloads on demand). */
  private armIdle() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => {
      if (this.state !== 'ready' || !this.idleMinutes) return
      if (Date.now() - this.lastUsed > this.idleMinutes * 60_000) {
        console.log('[clone] unloading idle voice engine')
        this.stop()
      }
    }, 30_000)
  }

  async synth(text: string, lang: 'ru' | 'en', speed = 1): Promise<Buffer> {
    this.lastUsed = Date.now()
    await this.ensure()
    const res = await fetch(`http://127.0.0.1:${this.port}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang, speed }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error('xtts: ' + (await res.text()).slice(0, 200))
    return Buffer.from(await res.arrayBuffer())
  }

  stop() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    this.set('off')
    try {
      this.proc?.kill()
    } catch {}
    this.proc = null
  }
}
