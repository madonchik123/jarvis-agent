import { BrowserWindow, screen, Display } from 'electron'
import { IPC, type HighlightTarget } from '../shared/types'
import { rendererUrl, preloadPath } from './paths'

interface Entry {
  win: BrowserWindow
  display: Display
  ready: Promise<void>
  targets: number
}

/**
 * Click-through, always-on-top, transparent windows (one per monitor). They draw
 *  - the "Jarvis is pointing here" outlines, and
 *  - the glowing screen edge + badge shown while Jarvis is controlling the computer.
 */
export class Overlay {
  private entries = new Map<number, Entry>()
  private hideTimer: NodeJS.Timeout | null = null
  private control = false
  private controlHint = ''

  private ensure(display: Display): Entry {
    let e = this.entries.get(display.id)
    if (e && !e.win.isDestroyed()) return e
    const b = display.bounds
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: { preload: preloadPath(), backgroundThrottling: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true, { forward: false })
    const ready = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    void win.loadURL(rendererUrl('overlay.html'))
    e = { win, display, ready, targets: 0 }
    this.entries.set(display.id, e)
    return e
  }

  private async reveal(e: Entry) {
    await e.ready
    if (e.win.isDestroyed()) return
    e.win.setBounds(e.display.bounds)
    if (!e.win.isVisible()) e.win.showInactive()
  }

  private maybeHide(e: Entry) {
    if (e.targets === 0 && !this.control && !e.win.isDestroyed() && e.win.isVisible()) {
      setTimeout(() => {
        if (e.targets === 0 && !this.control && !e.win.isDestroyed()) e.win.hide()
      }, 500)
      // an unused full-screen transparent window still costs ~90 MB: drop it after a quiet minute
      setTimeout(() => {
        if (e.targets === 0 && !this.control && !e.win.isDestroyed() && !e.win.isVisible()) {
          e.win.destroy()
          for (const [id, x] of this.entries) if (x === e) this.entries.delete(id)
        }
      }, 60_000)
    }
  }

  /** targets are in physical screen pixels */
  async show(targets: HighlightTarget[], ttlMs = 0) {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    const perDisplay = new Map<number, HighlightTarget[]>()
    for (const t of targets) {
      const dip = screen.screenToDipRect(null, { x: t.x, y: t.y, width: Math.max(1, t.w), height: Math.max(1, t.h) })
      const d = screen.getDisplayMatching(dip)
      const list = perDisplay.get(d.id) ?? []
      list.push({ ...t, x: dip.x - d.bounds.x, y: dip.y - d.bounds.y, w: dip.width, h: dip.height })
      perDisplay.set(d.id, list)
    }
    for (const d of screen.getAllDisplays()) {
      const list = perDisplay.get(d.id)
      const e = list || this.control ? this.ensure(d) : this.entries.get(d.id)
      if (!e) continue
      e.targets = list?.length ?? 0
      if (!list) {
        if (!e.win.isDestroyed()) e.win.webContents.send(IPC.highlightClear)
        this.maybeHide(e)
        continue
      }
      await this.reveal(e)
      e.win.webContents.send(IPC.highlight, list)
    }
    if (ttlMs > 0) this.hideTimer = setTimeout(() => this.clear(), ttlMs)
  }

  clear() {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    for (const e of this.entries.values()) {
      e.targets = 0
      if (!e.win.isDestroyed()) e.win.webContents.send(IPC.highlightClear)
      this.maybeHide(e)
    }
  }

  /** Glow the screen edges while Jarvis is driving the computer. */
  async setControl(on: boolean, hint = '') {
    if (on === this.control && hint === this.controlHint) return
    this.control = on
    this.controlHint = hint
    for (const d of screen.getAllDisplays()) {
      const e = on ? this.ensure(d) : this.entries.get(d.id)
      if (!e) continue
      if (on) await this.reveal(e)
      if (!e.win.isDestroyed()) e.win.webContents.send('overlay:control', on, hint, d.id === screen.getPrimaryDisplay().id)
      if (!on) this.maybeHide(e)
    }
  }

  dispose() {
    for (const e of this.entries.values()) if (!e.win.isDestroyed()) e.win.destroy()
    this.entries.clear()
  }
}
