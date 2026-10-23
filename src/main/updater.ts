import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { EventEmitter } from 'events'
import type { UpdateState } from '../shared/types'

/**
 * Auto-update from GitHub Releases (electron-updater reads latest.yml published by the release workflow).
 * Flow: check → "update available" → user downloads (or auto mode) → "restart to install". The installer is unsigned,
 * so nothing but the release assets of this repository is ever trusted (sha512 from latest.yml is verified).
 */
export class Updater extends EventEmitter {
  state: UpdateState = { status: 'idle', current: app.getVersion() }
  private timer: NodeJS.Timeout | null = null
  private mode: 'ask' | 'auto' | 'off' = 'ask'

  get supported() {
    return app.isPackaged
  }

  init(mode: 'ask' | 'auto' | 'off') {
    this.mode = mode
    if (!this.supported) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = { info: (m: any) => console.log('[update]', m), warn: (m: any) => console.warn('[update]', m), error: (m: any) => console.warn('[update]', m), debug: () => {} } as any
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ status: 'uptodate', checkedAt: Date.now() }))
    autoUpdater.on('update-available', (i) => {
      this.set({ status: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 600) : '', checkedAt: Date.now() })
      if (this.mode === 'auto') void this.download()
    })
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent), bytesPerSecond: Math.round(p.bytesPerSecond) }))
    autoUpdater.on('update-downloaded', (i) => this.set({ status: 'downloaded', version: i.version }))
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: String(e?.message || e).slice(0, 300) }))
    this.schedule()
  }

  setMode(mode: 'ask' | 'auto' | 'off') {
    this.mode = mode
    this.schedule()
  }

  private schedule() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.supported || this.mode === 'off') return
    setTimeout(() => void this.check(true), 20_000) // not during start-up
    this.timer = setInterval(() => void this.check(true), 6 * 3600_000)
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch, current: app.getVersion() }
    this.emit('state', this.state)
  }

  async check(silent = false) {
    if (!this.supported) {
      this.set({ status: 'unsupported' })
      return this.state
    }
    if (['downloading', 'downloaded'].includes(this.state.status)) return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch (e: any) {
      if (!silent) this.set({ status: 'error', error: String(e?.message || e).slice(0, 300) })
      else this.set({ status: 'idle' })
    }
    return this.state
  }

  async download() {
    if (this.state.status !== 'available') return this.state
    this.set({ status: 'downloading', percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (e: any) {
      this.set({ status: 'error', error: String(e?.message || e).slice(0, 300) })
    }
    return this.state
  }

  install() {
    if (this.state.status === 'downloaded') autoUpdater.quitAndInstall(false, true)
  }
}
