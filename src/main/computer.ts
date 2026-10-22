import { join } from 'path'
import { rmSync } from 'fs'
import { nativeImage } from 'electron'
import type { HighlightTarget } from '../shared/types'
import { normalize, phraseScore } from '../shared/textmatch'
import type { OcrResult, OcrLine, OcrWord, UiaElement, WinBridge, WinWindow } from './win'

/**
 * "Computer use" brain. The goal is to make any app drivable by a text-only model with very few round trips:
 *   • screen(): one call → numbered map of everything on screen (UI Automation elements ∪ OCR text lines),
 *     so apps with no accessibility tree (browsers, games, Electron…) are still usable.
 *   • act()/clickText(): act on a number or on visible text; each action returns a "what changed" digest,
 *     so the model never has to take a separate screenshot just to check the result.
 *   • waitFor()/openApp()/openUrl(): the things models otherwise fake with `sleep` and keyboard shortcuts.
 *   • a loop guard that stops thrashing.
 */

export interface Mark {
  id: number
  src: 'uia' | 'ocr'
  type: string
  text: string
  x: number
  y: number
  w: number
  h: number
  enabled?: boolean
  value?: string
  uiaId?: string
  words?: OcrWord[]
}

export interface Scan {
  at: number
  fg: Partial<WinWindow> & { title?: string; process?: string }
  screen: { x: number; y: number; w: number; h: number }
  marks: Mark[]
  ocr: OcrResult | null
  ms: number
}

export interface ComputerHub {
  win: WinBridge
  scanWin: WinBridge
  tmpDir: string
  highlight(targets: HighlightTarget[], ttlMs?: number): void
  askVision(jpeg: Buffer, question: string): Promise<string>
}

const INTERACTIVE = new Set(['Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem', 'RadioButton', 'Slider', 'Spinner', 'Tab', 'TabItem', 'TreeItem', 'SplitButton', 'Document', 'DataItem'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const cx = (m: { x: number; w: number }) => Math.round(m.x + m.w / 2)
const cy = (m: { y: number; h: number }) => Math.round(m.y + m.h / 2)

export class Computer {
  private idByKey = new Map<string, number>()
  private nextId = 1
  last: Scan | null = null
  private history: string[] = []
  private epoch = 0
  private actions = 0
  private screensInRow = 0
  /** item numbers the model has actually been shown in this task: a number it never saw (e.g. an element_index from get_app_state) must not resolve to some unrelated on-screen item */
  private shown = new Set<number>()

  constructor(private hub: ComputerHub) {}

  /** Stop everything in flight: pending actions notice the new epoch and abort before touching the PC. */
  cancel() {
    this.epoch++
  }

  /** Snapshot the epoch when a tool call starts; pass it to check() before each side effect. */
  begin() {
    return this.epoch
  }

  check(e: number) {
    if (e !== this.epoch) throw new Error('cancelled: the user stopped this task')
  }

  /** called at the start of each user request */
  reset() {
    this.history = []
    this.actions = 0
    this.screensInRow = 0
    this.shown.clear()
  }

  // ------------------------------------------------------------------ loop guard
  guard(tool: string, args: unknown, isAction: boolean): string | null {
    const sig = tool + ':' + JSON.stringify(args)
    this.history.push(sig)
    if (this.history.length > 10) this.history.shift()
    const same = this.history.filter((h) => h === sig).length
    if (isAction) {
      this.actions++
      this.screensInRow = 0
    } else if (tool === 'screen') {
      this.screensInRow++
    }
    if (same >= 3) {
      return `LOOP GUARD: you already did "${tool}" with the same arguments ${same} times and it did not solve the task. Change strategy: use click_text with the visible label, open_app/open_url, a keyboard shortcut, ask_screen to understand the screen, or ask the user with jarvis_ask. Do not repeat this call.`
    }
    if (this.screensInRow >= 3) {
      return 'LOOP GUARD: you looked at the screen 3 times without acting. Pick a target from the map and act on it (act / click_text), or ask the user.'
    }
    if (this.actions > 45) {
      return 'LOOP GUARD: 45 computer actions in this task. Stop, summarise what is done and what is blocking you, and ask the user (jarvis_ask) how to continue.'
    }
    return null
  }

  // ------------------------------------------------------------------ scanning
  private async capture(): Promise<{ path: string; x: number; y: number; w: number; h: number }> {
    const path = join(this.hub.tmpDir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`)
    const info = await this.hub.win.call<{ x: number; y: number; w: number; h: number }>('screenshot', { path, monitor: 'primary' })
    return { path, ...info }
  }

  async scan(o: { uia?: boolean; ocr?: boolean; keepShot?: boolean } = {}): Promise<Scan & { shotPath?: string }> {
    const t0 = Date.now()
    let fg = await this.hub.win.call<any>('foreground').catch(() => ({}) as any)
    if (!fg?.hwnd) {
      // no foreground window at this instant (app switching): fall back to the topmost real window
      const w = (await this.hub.win.call<WinWindow[]>('windows').catch(() => [])).find((x) => x.process !== 'electron')
      if (w) fg = w
    }
    const shot = await this.capture()
    const [ocr, uia] = await Promise.all([
      o.ocr === false ? null : this.hub.win.call<OcrResult>('ocr', { path: shot.path, ox: shot.x, oy: shot.y }, 30000).catch(() => null),
      o.uia === false || !fg.hwnd ? null : this.hub.scanWin.call<{ window: string; elements: UiaElement[] }>('uia', { hwnd: fg.hwnd, max: 260 }, 25000).catch(() => null)
    ])
    if (!o.keepShot) rmSync(shot.path, { force: true })
    const screen = { x: shot.x, y: shot.y, w: shot.w, h: shot.h }
    const marks = this.merge(uia?.elements ?? [], ocr, screen)
    const scan = { at: Date.now(), fg, screen, marks, ocr, ms: Date.now() - t0, shotPath: o.keepShot ? shot.path : undefined }
    if (process.env.JARVIS_DEBUG) console.log(`[computer] scan ${scan.ms}ms uia=${uia?.elements.length ?? '-'} ocr=${ocr?.lines.length ?? '-'}`)
    this.last = scan
    return scan
  }

  private merge(uia: UiaElement[], ocr: OcrResult | null, screen: { x: number; y: number; w: number; h: number }): Mark[] {
    const raw: Omit<Mark, 'id'>[] = []
    const inScreen = (r: { x: number; y: number; w: number; h: number }) => r.x + r.w > screen.x && r.y + r.h > screen.y && r.x < screen.x + screen.w && r.y < screen.y + screen.h && r.w > 3 && r.h > 3
    for (const e of uia) {
      if (!inScreen(e)) continue
      const interactive = INTERACTIVE.has(e.type)
      const text = (e.name || e.value || '').trim()
      if (!text && !interactive) continue
      raw.push({ src: 'uia', type: e.type, text: text || `(${e.type.toLowerCase()}${e.auto ? ' ' + e.auto : ''})`, x: e.x, y: e.y, w: e.w, h: e.h, enabled: e.enabled, value: e.value, uiaId: e.id })
    }
    const uiaMarks = raw.slice()
    for (const l of ocr?.lines ?? []) {
      const t = l.text.trim()
      if (t.length < 2 || !inScreen(l)) continue
      const nt = normalize(t)
      // skip OCR lines already represented by an accessibility element
      const dup = uiaMarks.some((u) => {
        const nu = normalize(u.text)
        if (!nu) return false
        const ix = Math.max(0, Math.min(u.x + u.w, l.x + l.w) - Math.max(u.x, l.x))
        const iy = Math.max(0, Math.min(u.y + u.h, l.y + l.h) - Math.max(u.y, l.y))
        const overlap = (ix * iy) / Math.max(1, l.w * l.h)
        return overlap > 0.5 && (nu.includes(nt) || nt.includes(nu) || phraseScore(nu, nt) > 0.7)
      })
      if (dup) continue
      raw.push({ src: 'ocr', type: 'text', text: t, x: l.x, y: l.y, w: l.w, h: l.h, words: l.words })
    }
    // reading order: rows of ~16px top→bottom, then left→right
    raw.sort((a, b) => Math.round(a.y / 16) - Math.round(b.y / 16) || a.x - b.x)
    return raw.slice(0, 220).map((m) => ({ ...m, id: this.stableId(m) }))
  }

  /** ids stay the same across re-scans while an element hasn't moved, so the model can keep using numbers. */
  private stableId(m: Omit<Mark, 'id'>): number {
    const key = `${m.src}|${normalize(m.text).slice(0, 40)}|${Math.round(m.x / 12)}|${Math.round(m.y / 12)}`
    let id = this.idByKey.get(key)
    if (!id) {
      id = this.nextId++
      this.idByKey.set(key, id)
      if (this.idByKey.size > 3000) this.idByKey.clear()
    }
    return id
  }

  markById(id: number): Mark | undefined {
    if (!this.shown.has(id)) return undefined
    return this.last?.marks.find((m) => m.id === id)
  }

  digest(scan: Scan, opts: { query?: string; max?: number } = {}): string {
    const max = opts.max ?? 130
    let marks = scan.marks
    if (opts.query) {
      const q = normalize(opts.query)
      marks = marks.filter((m) => normalize(m.text).includes(q))
    }
    const head = `Active window: "${scan.fg.title ?? '?'}" (${scan.fg.process ?? '?'}) • screen ${scan.screen.w}x${scan.screen.h} • ${scan.marks.length} items (${scan.marks.filter((m) => m.src === 'uia').length} UI, ${scan.marks.filter((m) => m.src === 'ocr').length} text) • scanned in ${scan.ms}ms`
    const lines = marks.slice(0, max).map((m) => this.fmt(m))
    const more = marks.length > max ? `\n… ${marks.length - max} more (use query to filter)` : ''
    return head + '\n' + lines.join('\n') + more
  }

  fmt(m: Mark): string {
    this.shown.add(m.id)
    const t = m.text.length > 90 ? m.text.slice(0, 88) + '…' : m.text
    const kind = m.src === 'uia' ? m.type : 'text'
    const val = m.value && m.value !== m.text ? ` = "${m.value.slice(0, 40)}"` : ''
    return `[${m.id}] ${kind} "${t}"${val}${m.enabled === false ? ' (disabled)' : ''} @${cx(m)},${cy(m)}`
  }

  /** What changed since `prev`: active window + new items (with ids) + count of vanished items. */
  async observe(prev: Scan | null, settleMs = 450): Promise<string> {
    await sleep(settleMs)
    const now = await this.scan({})
    const key = (m: Mark) => `${m.src === 'uia' ? m.type : 't'}|${normalize(m.text).slice(0, 50)}`
    const before = new Set((prev?.marks ?? []).map(key))
    const after = new Set(now.marks.map(key))
    const fresh = now.marks.filter((m) => !before.has(key(m)))
    const gone = [...before].filter((k) => !after.has(k)).length
    const winChanged = prev && (prev.fg.title !== now.fg.title || prev.fg.process !== now.fg.process)
    let out = `Now: "${now.fg.title ?? '?'}" (${now.fg.process ?? '?'})${winChanged ? ` — window changed from "${prev?.fg.title ?? '?'}"` : ''}.`
    if (!prev) return out + '\n' + this.digest(now, { max: 60 })
    if (!fresh.length && !gone) return out + ' Screen looks unchanged (action may not have had an effect).'
    out += ` ${fresh.length} new item(s), ${gone} gone.`
    const show = fresh.slice(0, 28).map((m) => this.fmt(m))
    if (show.length) out += '\nNew on screen:\n' + show.join('\n')
    if (fresh.length > 28) out += `\n… +${fresh.length - 28} more (call screen for the full map)`
    return out
  }

  // ------------------------------------------------------------------ finding things
  /** Best matches for `query` among accessibility names and OCR word sequences. */
  find(query: string, scan: Scan, includeFuzzy = true): { mark: Mark; rect: { x: number; y: number; w: number; h: number }; score: number }[] {
    const q = normalize(query)
    if (!q) return []
    const qWords = q.split(' ')
    const out: { mark: Mark; rect: { x: number; y: number; w: number; h: number }; score: number }[] = []
    for (const m of scan.marks) {
      const nt = normalize(m.text)
      if (!nt) continue
      if (m.src === 'uia') {
        const base = nt === q ? 1 : nt.startsWith(q) ? 0.96 : nt.includes(q) ? 0.9 : includeFuzzy ? phraseScore(nt, q) * 0.9 : 0
        // prefer real controls over labels/containers that merely carry the same text
        const bonus = INTERACTIVE.has(m.type) ? 0.06 : ['Text', 'Group', 'Pane', 'Window', 'Custom', 'ToolBar', 'Image'].includes(m.type) ? -0.12 : 0
        if (base >= 0.6) out.push({ mark: m, rect: { x: m.x, y: m.y, w: m.w, h: m.h }, score: base + bonus })
      } else if (m.words?.length) {
        const w = m.words
        for (let i = 0; i + qWords.length <= w.length; i++) {
          const slice = w.slice(i, i + qWords.length)
          const cand = normalize(slice.map((s) => s.t).join(' '))
          const score = cand === q ? 1 : cand.includes(q) ? 0.92 : includeFuzzy ? phraseScore(cand, q) : 0
          if (score >= 0.6) {
            const x1 = Math.min(...slice.map((s) => s.x))
            const y1 = Math.min(...slice.map((s) => s.y))
            const x2 = Math.max(...slice.map((s) => s.x + s.w))
            const y2 = Math.max(...slice.map((s) => s.y + s.h))
            out.push({ mark: m, rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, score })
          }
        }
        if (qWords.length > 1 && nt.includes(q) && !out.some((o) => o.mark === m)) out.push({ mark: m, rect: { x: m.x, y: m.y, w: m.w, h: m.h }, score: 0.88 })
      }
    }
    // best score first; among equals prefer things higher on screen
    return out.sort((a, b) => b.score - a.score || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  }

  // ------------------------------------------------------------------ acting
  private async pointer(x: number, y: number, kind: 'click' | 'double' | 'right' | 'hover') {
    this.hub.highlight([{ x: x - 20, y: y - 20, w: 40, h: 40, shape: 'circle' }], 800)
    if (kind === 'hover') return this.hub.win.call('move', { x, y })
    return this.hub.win.call('click', { x, y, button: kind === 'right' ? 'right' : 'left', double: kind === 'double' })
  }

  /**
   * Exactly ONE activation per call: either a UIA pattern (invoke/toggle/select/expand — no mouse involved) or, when
   * the element has no pattern, one real mouse click. Never both.
   */
  async actOnMark(m: Mark, kind: 'click' | 'double' | 'right' | 'hover'): Promise<string> {
    if (m.src === 'uia' && m.uiaId && kind === 'click' && m.type !== 'Edit' && m.type !== 'Document') {
      let usable = false
      try {
        const r = await this.hub.scanWin.call<{ done: string }>('uia_invoke', { id: m.uiaId }, 8000)
        this.hub.highlight([{ x: m.x, y: m.y, w: m.w, h: m.h, label: m.text.slice(0, 40) }], 800)
        return `activated via accessibility (${r.done}, no mouse)`
      } catch (e: any) {
        usable = /no-pattern|unknown element/.test(String(e?.message))
        if (!usable) throw e
      }
    }
    await this.pointer(cx(m), cy(m), kind)
    return kind === 'hover' ? 'hovered with mouse' : 'clicked with mouse'
  }

  async clickAt(x: number, y: number, kind: 'click' | 'double' | 'right' | 'hover') {
    await this.pointer(x, y, kind)
  }

  /** Put text into the focused control. Long/non-ASCII text goes through the clipboard (far more reliable). */
  async enter(text: string, mode: 'auto' | 'type' | 'paste' = 'auto') {
    const paste = mode === 'paste' || (mode === 'auto' && text.length > 400)
    if (!paste) return this.hub.win.call('type', { text })
    const old = await this.hub.win.call<string>('clipboard_get').catch(() => '')
    await this.hub.win.call('clipboard_set', { text })
    await sleep(60)
    await this.hub.win.call('keys', { keys: 'ctrl+v' })
    await sleep(120)
    if (old) await this.hub.win.call('clipboard_set', { text: old }).catch(() => {})
  }

  // ------------------------------------------------------------------ waiting
  /**
   * Wait until the screen has stopped changing (page finished loading, app finished opening, animation done).
   * Compares tiny thumbnails of consecutive screenshots; returns when nothing changed for `quietMs`, or at the timeout.
   */
  async waitStable(opts: { timeoutSec?: number; quietMs?: number; epoch: number }): Promise<{ stable: boolean; waitedMs: number; title: string }> {
    const t0 = Date.now()
    const deadline = t0 + Math.min(60, Math.max(1, opts.timeoutSec ?? 15)) * 1000
    const quietMs = opts.quietMs ?? 900
    let prev: Buffer | null = null
    let quietSince = 0
    while (Date.now() < deadline) {
      this.check(opts.epoch)
      const shot = await this.capture()
      const img = nativeImage.createFromPath(shot.path).resize({ width: 96, height: 54, quality: 'good' })
      rmSync(shot.path, { force: true })
      const bmp = img.toBitmap()
      if (prev && prev.length === bmp.length) {
        let diff = 0
        for (let i = 0; i < bmp.length; i += 4) diff += Math.abs(bmp[i] - prev[i]) + Math.abs(bmp[i + 1] - prev[i + 1]) + Math.abs(bmp[i + 2] - prev[i + 2])
        const mean = diff / ((bmp.length / 4) * 3)
        if (mean < 1.2) {
          if (!quietSince) quietSince = Date.now()
          if (Date.now() - quietSince >= quietMs) {
            const fg = await this.hub.win.call<any>('foreground').catch(() => ({}))
            return { stable: true, waitedMs: Date.now() - t0, title: fg.title ?? '' }
          }
        } else quietSince = 0
      }
      prev = bmp
      await sleep(250)
    }
    const fg = await this.hub.win.call<any>('foreground').catch(() => ({}))
    return { stable: false, waitedMs: Date.now() - t0, title: fg.title ?? '' }
  }

  async waitFor(opts: { text?: string; gone?: boolean; window?: string; timeoutSec?: number }): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + Math.min(60, opts.timeoutSec ?? 12) * 1000
    if (opts.window) {
      const w = await this.hub.win.call<WinWindow | null>('wait_window', { query: opts.window, ms: Math.max(500, deadline - Date.now()) }, deadline - Date.now() + 4000)
      return w ? { ok: true, detail: `window "${w.title}" (${w.process}) is open` } : { ok: false, detail: `window matching "${opts.window}" did not appear` }
    }
    const q = opts.text ?? ''
    while (Date.now() < deadline) {
      const s = await this.scan({ uia: false })
      const hit = this.find(q, s, false)[0]
      if (opts.gone ? !hit : hit && hit.score >= 0.8) {
        const nowScan = await this.scan({})
        return { ok: true, detail: opts.gone ? `"${q}" is gone` : `"${q}" is visible at ${cx(hit!.rect)},${cy(hit!.rect)}\n` + this.digest(nowScan, { max: 40 }) }
      }
      await sleep(500)
    }
    return { ok: false, detail: opts.gone ? `"${q}" is still on screen after ${opts.timeoutSec ?? 12}s` : `"${q}" did not appear within ${opts.timeoutSec ?? 12}s` }
  }

  async scrollFind(text: string, dir: 'down' | 'up', max = 8, at?: { x: number; y: number }) {
    for (let i = 0; i < max; i++) {
      const s = await this.scan({ uia: false })
      const hit = this.find(text, s, false)[0]
      if (hit && hit.score >= 0.8) return { found: true as const, hit, scan: s }
      await this.hub.win.call('scroll', { dy: dir === 'down' ? 5 : -5, x: at?.x ?? Math.round(s.screen.w / 2), y: at?.y ?? Math.round(s.screen.h / 2) })
      await sleep(350)
    }
    return { found: false as const }
  }

  // ------------------------------------------------------------------ vision helper
  async askScreen(question: string, extraHint = ''): Promise<string> {
    const shot = await this.capture()
    let img = nativeImage.createFromPath(shot.path)
    rmSync(shot.path, { force: true })
    if (shot.w > 1600) img = img.resize({ width: 1600 })
    const jpeg = img.toJPEG(78)
    return this.hub.askVision(jpeg, question + (extraHint ? '\n' + extraHint : ''))
  }

  windows() {
    return this.hub.win.call<WinWindow[]>('windows')
  }
}

export type { OcrLine }
