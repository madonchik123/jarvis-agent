import { createServer, IncomingMessage, Server } from 'http'
import { randomBytes } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { nativeImage } from 'electron'
import type { HighlightTarget, Routine, RoutineStep, Settings } from '../shared/types'
import type { MemoryStore, RoutineStore } from './store'
import type { WinBridge, WinWindow } from './win'
import { Computer } from './computer'
import { Ocu } from './ocu'

export interface Hub {
  settings(): Settings
  win: WinBridge
  scanWin: WinBridge
  tmpDir: string
  memory: MemoryStore
  routines: RoutineStore
  say(text: string, highlights?: HighlightTarget[]): Promise<void>
  highlight(targets: HighlightTarget[], ttlMs?: number): void
  clearHighlight(): void
  ask(question: string, options?: string[], timeoutSec?: number): Promise<string>
  runRoutine(r: Routine): Promise<string>
  isVision(): boolean
  askVision(jpeg: Buffer, question: string): Promise<string>
  confirmControl(what: string): Promise<boolean>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })

const inputStepSchema = z.object({
  do: z.enum(['key', 'hold', 'key_down', 'key_up', 'type', 'wait', 'click', 'move', 'mouse_down', 'mouse_up', 'scroll', 'drag']),
  keys: z.string().optional().describe('key / hold / key_down / key_up: "w", "ctrl+c", "enter", "ctrl+a delete"'),
  ms: z.number().optional().describe('hold / wait duration in milliseconds'),
  text: z.string().optional().describe('type: the text to type'),
  target: z.string().optional().describe('click / move / scroll / drag start: visible on-screen text to point at (instead of x,y)'),
  x: z.number().optional(),
  y: z.number().optional(),
  to_x: z.number().optional(),
  to_y: z.number().optional(),
  to_target: z.string().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  count: z.number().optional().describe('click: 2 = double-click'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().optional().describe('scroll: wheel notches'),
  modifiers: z.string().optional().describe('keys held during click/scroll/drag, e.g. "ctrl+shift"'),
  scan: z.boolean().optional().describe('send hardware scan codes (games)')
})

const targetSchema = z.object({
  x: z.number().optional().describe('screen x (pixels)'),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  find: z.string().optional().describe('visible on-screen text to find (OCR / accessibility) and outline'),
  mark: z.number().optional().describe('item number [N] printed by jarvis_screen / jarvis_click_text ONLY — never an element_index from get_app_state (use find for those)'),
  label: z.string().optional().describe('short caption drawn next to the outline'),
  shape: z.enum(['box', 'circle', 'arrow', 'underline']).optional()
})

const stepSchema = z.object({
  type: z.enum(['say', 'open', 'run', 'keys', 'type', 'wait', 'agent']),
  text: z.string().optional().describe('say/type: text'),
  target: z.string().optional().describe('open: app name, URL or file path'),
  command: z.string().optional().describe('run: PowerShell command'),
  keys: z.string().optional().describe('keys: e.g. "ctrl+shift+t"'),
  ms: z.number().optional().describe('wait: milliseconds'),
  prompt: z.string().optional().describe('agent: natural-language sub-task')
})

export function toSteps(raw: z.infer<typeof stepSchema>[]): RoutineStep[] {
  const out: RoutineStep[] = []
  for (const s of raw) {
    switch (s.type) {
      case 'say': out.push({ type: 'say', text: s.text || '' }); break
      case 'open': out.push({ type: 'open', target: s.target || '' }); break
      case 'run': out.push({ type: 'run', command: s.command || '' }); break
      case 'keys': out.push({ type: 'keys', keys: s.keys || '' }); break
      case 'type': out.push({ type: 'type', text: s.text || '' }); break
      case 'wait': out.push({ type: 'wait', ms: s.ms ?? 500 }); break
      case 'agent': out.push({ type: 'agent', prompt: s.prompt || '' }); break
    }
  }
  return out
}

type Click = 'click' | 'double' | 'right' | 'hover'

export class JarvisMcp {
  readonly token = randomBytes(24).toString('hex')
  private http: Server | null = null
  port = 0
  readonly computer: Computer
  readonly ocu = new Ocu()

  constructor(private hub: Hub) {
    this.computer = new Computer({
      win: hub.win,
      scanWin: hub.scanWin,
      tmpDir: hub.tmpDir,
      highlight: (t, ttl) => hub.highlight(t, ttl),
      askVision: (jpeg, q) => hub.askVision(jpeg, q)
    })
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  /** app the agent last acted on: keystrokes are routed to it (OCU clicks are background-only and leave focus elsewhere) */
  private lastApp = ''

  newTask() {
    this.computer.reset()
    this.lastApp = ''
  }

  async start() {
    mkdirSync(this.hub.tmpDir, { recursive: true })
    this.http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401).end()
        return
      }
      if (req.url !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined
        const server = this.buildServer()
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          transport.close()
          server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (e) {
        console.error('[mcp] request failed', e)
        if (!res.headersSent) res.writeHead(500).end()
      }
    })
    await new Promise<void>((r) => this.http!.listen(0, '127.0.0.1', () => r()))
    this.port = (this.http!.address() as any).port
  }

  stop() {
    this.http?.close()
    void this.ocu.stop()
  }

  // ------------------------------------------------------------------ helpers
  private async resolveTargets(targets: z.infer<typeof targetSchema>[]): Promise<HighlightTarget[]> {
    const c = this.computer
    const out: HighlightTarget[] = []
    let scan = c.last
    for (const t of targets) {
      if (t.mark !== undefined) {
        const m = c.markById(t.mark)
        if (m) out.push({ x: m.x, y: m.y, w: m.w, h: m.h, label: t.label ?? m.text.slice(0, 40), shape: t.shape })
        continue
      }
      if (t.find) {
        if (!scan || Date.now() - scan.at > 2500) scan = await c.scan({})
        const r = c.find(t.find, scan, true)[0]
        if (r && r.score >= 0.72) out.push({ ...r.rect, label: t.label, shape: t.shape })
        continue
      }
      if (t.x !== undefined && t.y !== undefined) out.push({ x: t.x, y: t.y, w: t.w ?? 60, h: t.h ?? 40, label: t.label, shape: t.shape })
    }
    return out
  }

  private async consent() {
    if (await this.hub.confirmControl('control the computer')) return null
    return err('The user declined permission to see/control the computer. Do not retry; tell the user (jarvis_say) and finish.')
  }

  /** Run a side-effecting step only if the task has not been cancelled since the tool call began. */
  private async live<T>(epoch: number, fn: () => Promise<T>): Promise<T> {
    this.computer.check(epoch)
    return fn()
  }

  private loop(tool: string, args: unknown, isAction: boolean) {
    const msg = this.computer.guard(tool, args, isAction)
    return msg ? err(msg) : null
  }

  /** Common tail of every action: observe what changed so the model does not need a separate screenshot. */
  private async result(summary: string, observe: boolean | undefined, settle = 450) {
    if (observe === false) return text(summary)
    const prev = this.computer.last
    try {
      const diff = await this.computer.observe(prev, settle)
      return text(`${summary}\n${diff}`)
    } catch (e: any) {
      return text(`${summary}\n(could not observe the result: ${e?.message || e})`)
    }
  }

  // ------------------------------------------------------------------ server
  private buildServer() {
    const s = new McpServer({ name: 'jarvis', version: '2.0.0' })
    const h = this.hub
    const c = this.computer

    // ---- voice -----------------------------------------------------------
    s.registerTool(
      'say',
      {
        description:
          'Speak ONE or TWO short sentences aloud (the only way to talk). Returns immediately; speech continues while you work. Optionally outline things on screen while speaking. Never read code/paths/long text.',
        inputSchema: {
          text: z.string().describe("what to say, <= 25 words, in the user's language"),
          highlight: z.array(targetSchema).optional(),
          wait: z.boolean().optional().describe('block until the line has been spoken (default false: keep working while speaking)')
        }
      },
      async ({ text: t, highlight, wait }) => {
        const targets = highlight?.length ? await this.resolveTargets(highlight) : []
        const speaking = h.say(t, targets)
        // by default speech runs in the background so the agent never waits for audio; a stuck audio path can't block it either
        if (wait) await Promise.race([speaking, new Promise((r) => setTimeout(r, 45000))])
        return text(wait ? 'spoken' : 'queued')
      }
    )

    s.registerTool(
      'ask',
      {
        description: 'Ask the user a question out loud and wait for their spoken (or tapped) answer. Optionally offer choices. Returns the reply.',
        inputSchema: { question: z.string(), options: z.array(z.string()).optional(), highlight: z.array(targetSchema).optional() }
      },
      async ({ question, options, highlight }) => {
        if (highlight?.length) h.highlight(await this.resolveTargets(highlight), 60000)
        const a = await h.ask(question, options)
        h.clearHighlight()
        return text(a ? `User answered: ${a}` : 'The user did not answer in time.')
      }
    )

    // ---- seeing ----------------------------------------------------------
    const screenImpl = async ({ query, image }: { query?: string; image?: boolean }) => {
      const g = await this.consent()
      if (g) return g
      const lp = this.loop('screen', { query }, false)
      if (lp) return lp
      const scan = await c.scan({ keepShot: h.isVision() || !!image })
      const content: any[] = [{ type: 'text', text: c.digest(scan, { query }) + '\n(Numbers are stable: use them with jarvis_act. Coordinates are screen pixels.)' }]
      if (scan.shotPath) {
        let img = nativeImage.createFromPath(scan.shotPath)
        if (scan.screen.w > 1600) img = img.resize({ width: 1600 })
        content.push({ type: 'image', data: img.toJPEG(72).toString('base64'), mimeType: 'image/jpeg' })
        rmSync(scan.shotPath, { force: true })
      }
      return { content }
    }
    const screenSchema = { query: z.string().optional().describe('only list items whose text contains this'), image: z.boolean().optional() }
    s.registerTool(
      'screen',
      {
        description:
          'LOOK at the screen. Returns a numbered map of everything visible in the active window and on screen: accessibility elements (buttons, fields, links, tabs…) AND all on-screen text found by OCR — so it works in ANY app (browsers, games, Electron, custom UIs). Then act with jarvis_act (by number) or jarvis_click_text (by label).',
        inputSchema: screenSchema
      },
      screenImpl
    )
    s.registerTool('screenshot', { description: 'Alias of jarvis_screen.', inputSchema: screenSchema }, screenImpl)

    s.registerTool(
      'ask_screen',
      {
        description:
          'Ask a vision model a question about what is on screen right now ("how many Robux are shown?", "which button looks like Play?", "is the page still loading?"). Slower (~10-20 s) but it truly SEES icons, images, charts and layout. Use when the text map is not enough.',
        inputSchema: { question: z.string() }
      },
      async ({ question }) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('ask_screen', { question }, false)
        if (lp) return lp
        try {
          const ans = await c.askScreen(question)
          return text(ans)
        } catch (e: any) {
          return err('Vision helper failed: ' + (e?.message || e) + '. Fall back to jarvis_screen text.')
        }
      }
    )

    s.registerTool(
      'windows',
      { description: 'List visible top-level windows (title, process, rect, focused).', inputSchema: {} },
      async () => {
        const w = await h.win.call<WinWindow[]>('windows')
        return text(w.map((x) => `${x.hwnd} ${x.process} "${x.title}" [${x.x},${x.y},${x.w},${x.h}]${x.focused ? ' FOCUSED' : ''}${x.minimized ? ' minimized' : ''}`).join('\n'))
      }
    )

    // ---- acting ----------------------------------------------------------
    s.registerTool(
      'act',
      {
        description:
          'Act on an item number from jarvis_screen: click (default), double_click, right_click, hover, or type (clicks the field, then types `text`; submit:true presses Enter). Returns what changed on screen, so you do NOT need another screenshot.',
        inputSchema: {
          id: z.number(),
          action: z.enum(['click', 'double_click', 'right_click', 'hover', 'type']).optional(),
          text: z.string().optional(),
          submit: z.boolean().optional(),
          replace: z.boolean().optional().describe('type: select all existing text first'),
          observe: z.boolean().optional().describe('default true — set false to skip the follow-up scan (faster)')
        }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('act', a, true)
        if (lp) return lp
        const ep = c.begin()
        const m = c.markById(a.id)
        if (!m) return err(`No item [${a.id}] in the last screen map. Call jarvis_screen again (items change as the screen changes).`)
        const kind: Click = a.action === 'double_click' ? 'double' : a.action === 'right_click' ? 'right' : a.action === 'hover' ? 'hover' : 'click'
        const prev = c.last
        try {
        if (a.action === 'type') {
          c.check(ep)
          await c.clickAt(Math.round(m.x + Math.min(m.w - 4, Math.max(8, m.w / 2))), Math.round(m.y + m.h / 2), 'click')
          await new Promise((r) => setTimeout(r, 160))
          c.check(ep)
          if (a.replace) await h.win.call('keys', { keys: 'ctrl+a' })
          c.check(ep)
          await c.enter(a.text ?? '')
          if (a.submit) {
            c.check(ep)
            await h.win.call('keys', { keys: 'enter' })
          }
          void prev
          return this.result(`typed into [${m.id}] ${m.text.slice(0, 40)}${a.submit ? ' and pressed Enter' : ''}`, a.observe, a.submit ? 900 : 450)
        }
        c.check(ep)
        const how = await c.actOnMark(m, kind)
        return this.result(`${how} [${m.id}] ${m.type} "${m.text.slice(0, 50)}"`, a.observe, 600)
        } catch (e: any) {
          return err(String(e?.message || e))
        }
      }
    )

    s.registerTool(
      'click_text',
      {
        description:
          'Find a visible label/text on screen (accessibility name or OCR) and click it — ONE call instead of screenshot+click. Works for tabs, links, buttons, menu entries, list items in any app. nth picks among duplicates (0 = best/topmost).',
        inputSchema: {
          text: z.string().describe('the visible text to click, as shown on screen'),
          action: z.enum(['click', 'double_click', 'right_click', 'hover']).optional(),
          nth: z.number().optional(),
          observe: z.boolean().optional()
        }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('click_text', a, true)
        if (lp) return lp
        const ep = c.begin()
        let scan = c.last && Date.now() - c.last.at < 1200 ? c.last : await c.scan({})
        let hits = c.find(a.text, scan, true).filter((x) => x.score >= 0.72)
        if (!hits.length) {
          scan = await c.scan({}) // one retry with a fresh scan (page may still be rendering)
          hits = c.find(a.text, scan, true).filter((x) => x.score >= 0.72)
        }
        if (!hits.length) {
          const near = c.find(a.text, scan, true).slice(0, 5).map((x) => c.fmt(x.mark))
          return err(`"${a.text}" not found on screen.${near.length ? ' Closest items:\n' + near.join('\n') : ''}\nTry jarvis_screen to see what is there, scroll, or switch window/tab first.`)
        }
        const hit = hits[Math.min(a.nth ?? 0, hits.length - 1)]
        const kind: Click = a.action === 'double_click' ? 'double' : a.action === 'right_click' ? 'right' : a.action === 'hover' ? 'hover' : 'click'
        let how = 'clicked with mouse'
        try {
          c.check(ep)
          if (hit.mark.src === 'uia' && kind === 'click') how = await c.actOnMark(hit.mark, 'click')
          else await c.clickAt(Math.round(hit.rect.x + hit.rect.w / 2), Math.round(hit.rect.y + hit.rect.h / 2), kind)
        } catch (e: any) {
          return err(String(e?.message || e))
        }
        const extra = hits.length > 1 ? ` (${hits.length} matches; used #${Math.min(a.nth ?? 0, hits.length - 1)})` : ''
        return this.result(`${how} "${hit.mark.text.slice(0, 50)}" at ${Math.round(hit.rect.x + hit.rect.w / 2)},${Math.round(hit.rect.y + hit.rect.h / 2)}${extra}`, a.observe, 650)
      }
    )

    /** Real keystrokes go to the FOREGROUND window: make sure that is the app we are working in (clicks via accessibility don't focus it). */
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const focusApp = async (app?: string) => {
      const target = (app || this.lastApp || '').trim().toLowerCase()
      if (!target) return
      try {
        const fg = await h.win.call<{ process?: string; title?: string }>('foreground')
        const hit = (v?: string) => !!v && (v.toLowerCase().includes(target) || target.includes(v.toLowerCase()))
        if (hit(fg?.process) || hit(fg?.title)) return
        await h.win.call('focus', { title: target })
        await sleep(150)
      } catch {
        /* window not found: keys go to whatever is in front */
      }
    }
    const foregroundNote = async () => {
      try {
        const fg = await h.win.call<{ process?: string; title?: string }>('foreground')
        return `Foreground: "${(fg.title || '').slice(0, 60)}" (${fg.process || '?'})`
      } catch {
        return ''
      }
    }
    const typeText = async (value: string) => {
      const lines = value.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await h.win.call('keys', { keys: 'shift+enter' })
        if (lines[i]) await h.win.call('type', { text: lines[i] })
      }
    }
    const MEDIA = /^(playpause|nexttrack|prevtrack|volumeup|volumedown|mute)$/i

    s.registerTool(
      'keys',
      {
        description:
          'Press keys/chords: "ctrl+l", "alt+tab", "win+r", "enter", "ctrl+a delete" (space-separated sequence), media keys playpause/nexttrack/prevtrack/volumeup/volumedown/mute. Keys go to the focused window; pass `app` (or it uses the app you last worked in) so the right window is brought to the front first.',
        inputSchema: { keys: z.string(), app: z.string().optional(), observe: z.boolean().optional() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('keys', a, true)
        if (lp) return lp
        const ep = c.begin()
        c.check(ep)
        const media = a.keys.split(/\s+/).every((k) => MEDIA.test(k))
        if (!media && !/\b(win|alt)\+/i.test(a.keys)) await focusApp(a.app)
        c.check(ep)
        try {
          await h.win.call('keys', { keys: a.keys })
        } catch (e: any) {
          return err(String(e?.message || e))
        }
        return this.result('pressed ' + a.keys + (media ? '' : '. ' + (await foregroundNote())), a.observe ?? false, 300)
      }
    )

    s.registerTool(
      'type',
      {
        description:
          'Type text with REAL keystrokes into any app — works where set_value/type_text fail (Telegram, Discord, browsers, games, custom-drawn UIs), any language/emoji. Optionally: app (window to bring to the front), into (visible label/placeholder of the field to click first, e.g. "Write a message..."), clear (select-all + delete first), submit (press Enter after). One call replaces click + paste + enter.',
        inputSchema: {
          text: z.string(),
          app: z.string().optional(),
          into: z.string().optional().describe('visible text of the input field to click before typing'),
          clear: z.boolean().optional(),
          submit: z.boolean().optional(),
          observe: z.boolean().optional()
        }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('type', a, true)
        if (lp) return lp
        const ep = c.begin()
        try {
          await focusApp(a.app)
          c.check(ep)
          if (a.into) {
            let scan = await c.scan({})
            let hits = c.find(a.into, scan, true).filter((x) => x.score >= 0.7)
            if (!hits.length) {
              await sleep(500)
              scan = await c.scan({})
              hits = c.find(a.into, scan, true).filter((x) => x.score >= 0.7)
            }
            if (!hits.length) return err(`Field "${a.into}" not found on screen — nothing typed. Use jarvis_screen to see the labels, or click the field first and call jarvis_type without \`into\`.`)
            const hit = hits[0]
            await c.clickAt(Math.round(hit.rect.x + hit.rect.w / 2), Math.round(hit.rect.y + hit.rect.h / 2), 'click')
            await sleep(220)
            c.check(ep)
          }
          if (a.clear) {
            await h.win.call('keys', { keys: 'ctrl+a' })
            await sleep(50)
            await h.win.call('keys', { keys: 'delete' })
            await sleep(50)
          }
          c.check(ep)
          await typeText(a.text)
          if (a.submit) {
            await sleep(120)
            await h.win.call('keys', { keys: 'enter' })
          }
        } catch (e: any) {
          return err(String(e?.message || e))
        }
        return this.result(`typed ${a.text.length} characters${a.submit ? ' and pressed Enter' : ''}. ${await foregroundNote()}`, a.observe ?? true, 500)
      }
    )

    // ---- low-level input: wheel, mouse buttons, held keys, timed sequences ------------------------------------------------
    type Step = z.infer<typeof inputStepSchema>
    const clampMs = (v: number | undefined, d: number, max: number) => Math.max(0, Math.min(max, Math.round(v ?? d)))
    /** screen point of a step: explicit x/y, or the best on-screen match of `target` */
    const pointOf = async (x: number | undefined, y: number | undefined, target: string | undefined, what: string) => {
      if (x !== undefined && y !== undefined) return { x: Math.round(x), y: Math.round(y) }
      if (!target) throw new Error(`${what}: give x,y or a visible-text target`)
      let scan = c.last && Date.now() - c.last.at < 700 ? c.last : await c.scan({})
      let hit = c.find(target, scan, true).filter((r) => r.score >= 0.7)[0]
      if (!hit) {
        await sleep(400)
        scan = await c.scan({})
        hit = c.find(target, scan, true).filter((r) => r.score >= 0.7)[0]
      }
      if (!hit) throw new Error(`${what}: "${target}" not found on screen`)
      return { x: Math.round(hit.rect.x + hit.rect.w / 2), y: Math.round(hit.rect.y + hit.rect.h / 2) }
    }
    const held = new Set<string>()
    const releaseAll = async () => {
      for (const k of [...held]) {
        const [keys, scan] = k.split('|')
        await h.win.call('keyup', { keys, scan: scan === '1' }).catch(() => {})
        held.delete(k)
      }
    }
    const holdFor = async (ms: number, ep: number) => {
      for (let left = ms; left > 0; left -= 200) {
        c.check(ep)
        await sleep(Math.min(200, left))
      }
    }
    const execStep = async (st: Step, ep: number): Promise<string> => {
      c.check(ep)
      const mods = (st.modifiers || '').replace(/\s+/g, '')
      const withMods = async <T>(fn: () => Promise<T>) => {
        if (mods) await h.win.call('keydown', { keys: mods })
        try {
          return await fn()
        } finally {
          if (mods) await h.win.call('keyup', { keys: mods }).catch(() => {})
        }
      }
      switch (st.do) {
        case 'wait': {
          const ms = clampMs(st.ms, 500, 15000)
          await holdFor(ms, ep)
          return `wait ${ms}ms`
        }
        case 'key': {
          if (!st.keys) throw new Error('key: keys missing')
          if (st.scan) {
            await h.win.call('keydown', { keys: st.keys, scan: true })
            await sleep(60)
            await h.win.call('keyup', { keys: st.keys, scan: true })
          } else await h.win.call('keys', { keys: st.keys })
          return `key ${st.keys}`
        }
        case 'hold': {
          if (!st.keys) throw new Error('hold: keys missing')
          const ms = clampMs(st.ms, 500, 20000)
          const tag = `${st.keys}|${st.scan ? 1 : 0}`
          await h.win.call('keydown', { keys: st.keys, scan: !!st.scan })
          held.add(tag)
          try {
            // like a real keyboard: after ~0.4 s the key auto-repeats (text fields type the character again and again)
            const t0 = Date.now()
            await holdFor(Math.min(ms, 400), ep)
            while (Date.now() - t0 < ms) {
              c.check(ep)
              await h.win.call('keydown', { keys: st.keys, scan: !!st.scan })
              await sleep(35)
            }
          } finally {
            await h.win.call('keyup', { keys: st.keys, scan: !!st.scan }).catch(() => {})
            held.delete(tag)
          }
          return `hold ${st.keys} ${ms}ms`
        }
        case 'key_down':
        case 'key_up': {
          if (!st.keys) throw new Error(`${st.do}: keys missing`)
          const down = st.do === 'key_down'
          await h.win.call(down ? 'keydown' : 'keyup', { keys: st.keys, scan: !!st.scan })
          const tag = `${st.keys}|${st.scan ? 1 : 0}`
          if (down) held.add(tag)
          else held.delete(tag)
          return `${st.do} ${st.keys}`
        }
        case 'type':
          await typeText(st.text ?? '')
          return `type ${(st.text ?? '').length} chars`
        case 'move': {
          const p = await pointOf(st.x, st.y, st.target, 'move')
          await h.win.call('move', p)
          return `move ${p.x},${p.y}`
        }
        case 'click': {
          const p = await pointOf(st.x, st.y, st.target, 'click')
          await withMods(() => h.win.call('click', { ...p, button: st.button ?? 'left', double: (st.count ?? 1) >= 2 }))
          return `${st.button ?? 'left'}-click${(st.count ?? 1) >= 2 ? '×2' : ''} ${p.x},${p.y}${mods ? ' +' + mods : ''}`
        }
        case 'mouse_down':
        case 'mouse_up': {
          const p = st.x !== undefined || st.target ? await pointOf(st.x, st.y, st.target, st.do) : undefined
          await h.win.call('mousebtn', { ...(p ?? {}), button: st.button ?? 'left', state: st.do === 'mouse_down' ? 'down' : 'up' })
          return `${st.do} ${st.button ?? 'left'}`
        }
        case 'scroll': {
          const p = st.x !== undefined || st.target ? await pointOf(st.x, st.y, st.target, 'scroll') : undefined
          const n = Math.max(1, Math.min(60, Math.round(st.amount ?? 5)))
          const dir = st.direction ?? 'down'
          await withMods(() => h.win.call('scroll', { ...(p ?? {}), dy: dir === 'down' ? n : dir === 'up' ? -n : 0, dx: dir === 'right' ? n : dir === 'left' ? -n : 0 }))
          return `scroll ${dir} ${n}${p ? ` at ${p.x},${p.y}` : ''}`
        }
        case 'drag': {
          const a = await pointOf(st.x, st.y, st.target, 'drag from')
          const b = await pointOf(st.to_x, st.to_y, st.to_target, 'drag to')
          await withMods(() => h.win.call('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
          return `drag ${a.x},${a.y} → ${b.x},${b.y}`
        }
      }
    }
    const runSteps = async (steps: Step[], app: string | undefined, observe: boolean | undefined, ep: number) => {
      const budget = steps.reduce((t, st) => t + (st.do === 'wait' || st.do === 'hold' ? (st.ms ?? 500) : 0), 0)
      if (budget > 60000) return err('Sequence waits/holds add up to more than 60 s — split it into shorter sequences.')
      const log: string[] = []
      const prev = c.last
      try {
        await focusApp(app)
        for (let i = 0; i < steps.length; i++) {
          try {
            log.push(await execStep(steps[i], ep))
          } catch (e: any) {
            if (/cancelled/.test(String(e?.message))) throw e
            return err(`Step ${i + 1} (${steps[i].do}) failed: ${e?.message || e}\nDone before that: ${log.join(' → ') || '(nothing)'}`)
          }
        }
      } catch (e: any) {
        return err(String(e?.message || e))
      } finally {
        await releaseAll()
      }
      void prev
      return this.result(`ran ${steps.length} step(s): ${log.join(' → ')}. ${await foregroundNote()}`, observe ?? false, 350)
    }

    s.registerTool(
      'sequence',
      {
        description:
          'Run a timed series of low-level inputs in ONE call (games, drawing, drag & drop, multi-key combos, anything that needs timing). Steps run in order; e.g. press w for 500 ms, wait, Enter: [{do:"hold",keys:"w",ms:500},{do:"wait",ms:300},{do:"key",keys:"enter"}]. Step kinds: key (chord or "ctrl+a delete" list), hold (keep keys down for ms), key_down/key_up, type (text), wait (ms), click (x,y or target text; button left/right/middle; count 2 = double; modifiers "ctrl+shift"), move, mouse_down/mouse_up (button), scroll (direction, amount notches, optional x,y/target, modifiers), drag (x,y|target → to_x,to_y|to_target). Coordinates are screen pixels. Add scan:true on key steps for games that ignore normal key events. Max 60 steps, 60 s of waiting/holding in total; held keys are always released.',
        inputSchema: { steps: z.array(inputStepSchema).min(1).max(60), app: z.string().optional().describe('window to bring to the front first'), observe: z.boolean().optional() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('sequence', a, true)
        if (lp) return lp
        return runSteps(a.steps, a.app, a.observe, c.begin())
      }
    )

    s.registerTool(
      'hold_key',
      {
        description: 'Hold a key (or chord) down for a number of milliseconds, then release — walking/steering in games, long-press. Example: keys "w", ms 800. scan:true for games that ignore normal key events.',
        inputSchema: { keys: z.string(), ms: z.number().describe('hold time in milliseconds (max 20000)'), app: z.string().optional(), scan: z.boolean().optional() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('hold_key', a, true)
        if (lp) return lp
        return runSteps([{ do: 'hold', keys: a.keys, ms: a.ms, scan: a.scan }], a.app, false, c.begin())
      }
    )

    s.registerTool(
      'scroll_at',
      {
        description:
          'Scroll with the mouse wheel anywhere on screen (works in every app: browsers, Telegram, documents, maps, lists) — no element index needed. Scrolls whatever is under the pointer: pass x,y, or `target` (visible text to hover first), otherwise the current pointer position. amount = wheel notches (default 5, ~1/3 page each). modifiers "ctrl" zooms in browsers/maps.',
        inputSchema: {
          direction: z.enum(['up', 'down', 'left', 'right']),
          amount: z.number().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          target: z.string().optional(),
          modifiers: z.string().optional(),
          app: z.string().optional(),
          observe: z.boolean().optional()
        }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('scroll_at', a, true)
        if (lp) return lp
        return runSteps([{ do: 'scroll', direction: a.direction, amount: a.amount, x: a.x, y: a.y, target: a.target, modifiers: a.modifiers }], a.app, a.observe ?? true, c.begin())
      }
    )

    s.registerTool(
      'mouse',
      {
        description:
          'Raw mouse control at screen pixels or on a visible-text target: click / double / right / middle / move (hover) / down / up / drag. Use for canvases, games, sliders, drag & drop, ctrl/shift-click (modifiers "ctrl", "shift", "ctrl+shift"). Prefer jarvis_click_text for ordinary buttons.',
        inputSchema: {
          action: z.enum(['click', 'double', 'right', 'middle', 'move', 'down', 'up', 'drag']),
          x: z.number().optional(),
          y: z.number().optional(),
          target: z.string().optional().describe('visible text to point at instead of x,y'),
          to_x: z.number().optional(),
          to_y: z.number().optional(),
          to_target: z.string().optional(),
          button: z.enum(['left', 'right', 'middle']).optional().describe('for down/up'),
          modifiers: z.string().optional(),
          app: z.string().optional(),
          observe: z.boolean().optional()
        }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('mouse', a, true)
        if (lp) return lp
        const base = { x: a.x, y: a.y, target: a.target, modifiers: a.modifiers }
        const step: Step =
          a.action === 'click' ? { do: 'click', ...base }
          : a.action === 'double' ? { do: 'click', ...base, count: 2 }
          : a.action === 'right' ? { do: 'click', ...base, button: 'right' }
          : a.action === 'middle' ? { do: 'click', ...base, button: 'middle' }
          : a.action === 'move' ? { do: 'move', ...base }
          : a.action === 'down' ? { do: 'mouse_down', ...base, button: a.button }
          : a.action === 'up' ? { do: 'mouse_up', ...base, button: a.button }
          : { do: 'drag', ...base, to_x: a.to_x, to_y: a.to_y, to_target: a.to_target }
        return runSteps([step], a.app, a.observe ?? true, c.begin())
      }
    )

    // ---- Codex-style computer use (Open Computer Use, MIT): accessibility tree + element indexes -----------------------
    const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + `\n… [${t.length - n} more characters cut — call get_app_state with a larger text_limit / query a narrower window]` : t)
    const ocuRun = async (name: string, args: Record<string, unknown>, isAction: boolean) => {
      const g = await this.consent()
      if (g) return g
      const lp = this.loop(isAction ? 'ocu_' + name : 'screen', args, isAction)
      if (lp) return lp
      const ep = c.begin()
      if (typeof args.app === 'string' && args.app) this.lastApp = args.app
      try {
        c.check(ep)
        let r = await this.ocu.call(name, args)
        // The app is probably still opening / its window not built yet: wait and retry here instead of letting the
        // model spam the tool (each retry used to cost a full model round-trip).
        const notReady = (t: string) => /not running|no (key )?window|not found|no such app|could not find|window.*not.*(available|found)/i.test(t)
        if (name === 'get_app_state' && r.isError && notReady(r.text)) {
          for (let i = 0; i < 8 && r.isError && notReady(r.text); i++) {
            await new Promise((res) => setTimeout(res, 1250))
            c.check(ep)
            r = await this.ocu.call(name, args)
          }
          if (r.isError) r.text += '\n(Waited ~10 s for the app to appear. If it is not running start it with jarvis_open_app, then call jarvis_wait.)'
        }
        c.check(ep)
        let body = clip(r.text, name === 'get_app_state' ? 16000 : 9000) || '(done)'
        if (name === 'get_app_state' && !r.isError) {
          // custom-drawn UIs (Qt/Telegram, games, some Electron apps) expose only anonymous "group ID: class …" nodes
          const lines = r.text.split('\n').filter((l) => l.trim())
          const anon = lines.filter((l) => /ID: class /.test(l)).length
          if (lines.length > 20 && anon / lines.length > 0.45) {
            body += '\n\nNOTE: this app exposes almost no accessibility info (custom-drawn UI). Do NOT rely on element indexes here: use jarvis_screen + jarvis_click_text("visible label"), jarvis_type(text, into:"field label", submit) for typing, and jarvis_keys for shortcuts.'
          }
        }
        const content: any[] = [{ type: 'text', text: body }]
        if (r.image && h.isVision()) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType })
        return r.isError ? { content, isError: true } : { content }
      } catch (e: any) {
        const m = String(e?.message || e)
        return err(m.includes('timed out') ? 'The app did not respond in time. Try get_app_state again.' : m + '\nIf the app is not running use jarvis_open_app first; call jarvis_list_apps to see exact app names.')
      }
    }
    s.registerTool(
      'list_apps',
      { description: 'List running apps (and recently used ones) with exact names to use in the other computer tools.', inputSchema: {} },
      async () => {
        const r = await ocuRun('list_apps', {}, false)
        return r
      }
    )
    s.registerTool(
      'get_app_state',
      {
        description:
          "PRIMARY way to look at an app: returns the app's key window as an indexed accessibility tree (every control with its element_index, role, label and available secondary actions). Call it once per task step before acting on an app, and again after the UI changes. Works on background windows.",
        inputSchema: {
          app: z.string().describe('app name from jarvis_list_apps (e.g. "Калькулятор", "vivaldi")'),
          max_tree_nodes: z.number().optional().describe('default 450; raise for long pages/lists'),
          text_limit: z.union([z.number(), z.literal('max')]).optional().describe('max characters of text content per node, default 300')
        }
      },
      async (a) => ocuRun('get_app_state', { ...a, max_tree_nodes: a.max_tree_nodes ?? 450, text_limit: a.text_limit ?? 300 }, false)
    )
    s.registerTool(
      'click',
      {
        description:
          'Click an element by element_index (preferred, from the latest get_app_state) or at x,y pixel coordinates of the app window. Returns the refreshed app state. Use click_count 2 for double-click.',
        inputSchema: {
          app: z.string(),
          element_index: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          click_count: z.number().optional(),
          click_method: z.enum(['auto', 'accessibility', 'app_post']).optional()
        }
      },
      async (a) => ocuRun('click', a, true)
    )
    s.registerTool(
      'perform_secondary_action',
      {
        description: 'Run a secondary action an element exposes in get_app_state (e.g. Expand, Collapse, ScrollIntoView, Toggle, Invoke).',
        inputSchema: { app: z.string(), element_index: z.string(), action: z.string() }
      },
      async (a) => ocuRun('perform_secondary_action', a, true)
    )
    s.registerTool(
      'set_value',
      {
        description: 'Set the value of an editable element directly (text fields, sliders, combo boxes). Faster and more reliable than typing. Returns refreshed app state.',
        inputSchema: { app: z.string(), element_index: z.string(), value: z.string() }
      },
      async (a) => ocuRun('set_value', a, true)
    )
    s.registerTool(
      'type_text',
      {
        description: 'Type literal text into the focused control of the app (click or set focus on the field first, or use set_value).',
        inputSchema: { app: z.string(), text: z.string() }
      },
      async (a) => {
        // our own Unicode keystrokes: the OCU text path is disabled for most apps and the clipboard route was layout-fragile
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('type_text', a, true)
        if (lp) return lp
        const ep = c.begin()
        this.lastApp = a.app || this.lastApp
        try {
          await focusApp(a.app)
          c.check(ep)
          await typeText(a.text)
        } catch (e: any) {
          return err(String(e?.message || e))
        }
        return this.result(`typed ${a.text.length} characters. ${await foregroundNote()}`, true, 500)
      }
    )
    s.registerTool(
      'press_key',
      {
        description: 'Press a key or chord in the app: "Return", "Tab", "ctrl+a", "alt+F4", "Up". (For media/volume keys and global shortcuts use jarvis_keys.)',
        inputSchema: { app: z.string(), key: z.string() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('press_key', a, true)
        if (lp) return lp
        const ep = c.begin()
        this.lastApp = a.app || this.lastApp
        try {
          await focusApp(a.app)
          c.check(ep)
          await h.win.call('keys', { keys: a.key })
        } catch (e: any) {
          return err(String(e?.message || e))
        }
        return this.result(`pressed ${a.key}. ${await foregroundNote()}`, true, 400)
      }
    )
    s.registerTool(
      'scroll',
      {
        description: 'Scroll a scrollable element (element_index from get_app_state) up/down/left/right by a number of pages.',
        inputSchema: { app: z.string(), element_index: z.string(), direction: z.enum(['up', 'down', 'left', 'right']), pages: z.number().optional() }
      },
      async (a) => ocuRun('scroll', a, true)
    )
    s.registerTool(
      'drag',
      {
        description: 'Drag from (from_x,from_y) to (to_x,to_y) in window pixel coordinates.',
        inputSchema: { app: z.string(), from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }
      },
      async (a) => ocuRun('drag', a, true)
    )


    s.registerTool(
      'wait',
      {
        description:
          'Pause so slow things can finish instead of retrying tools: an app opening, a web page loading, a dialog appearing. Either wait a fixed number of seconds, or until:"stable" (default) — returns as soon as the screen has stopped changing (or at the timeout). Use right after open_app/open_url/click on a link, then continue. For "wait until this text/window appears" use jarvis_wait_for.',
        inputSchema: {
          seconds: z.number().optional().describe('fixed pause, 0.5–60 s (ignored when until is "stable")'),
          until: z.enum(['stable', 'time']).optional().describe('"stable" = until the screen stops changing (default), "time" = exactly `seconds`'),
          timeout: z.number().optional().describe('max seconds to wait for stability (default 15)')
        }
      },
      async (a) => {
        const lp = this.loop('wait', a, false)
        if (lp) return lp
        const ep = c.begin()
        try {
          if (a.until === 'time' || (a.seconds !== undefined && a.until === undefined && a.timeout === undefined)) {
            const ms = Math.min(60, Math.max(0.5, a.seconds ?? 2)) * 1000
            const t0 = Date.now()
            while (Date.now() - t0 < ms) {
              c.check(ep)
              await new Promise((r) => setTimeout(r, Math.min(300, ms - (Date.now() - t0))))
            }
            return text(`waited ${(ms / 1000).toFixed(1)} s`)
          }
          const g = await this.consent()
          if (g) return g
          const r = await c.waitStable({ timeoutSec: a.timeout ?? 15, epoch: ep })
          return text(
            r.stable
              ? `Screen settled after ${(r.waitedMs / 1000).toFixed(1)} s. Active window: "${r.title}". Continue.`
              : `Still changing after ${(r.waitedMs / 1000).toFixed(0)} s (probably an animation, video or a page still loading). Active window: "${r.title}". Continue anyway, or wait again / use jarvis_wait_for with expected text.`
          )
        } catch (e: any) {
          return err(String(e?.message || e))
        }
      }
    )

    s.registerTool(
      'wait_for',
      {
        description:
          'Wait (polling) until some text appears on screen (or disappears with gone:true), or until a window whose title/process contains `window` exists. Use this instead of sleeping. Default timeout 12 s.',
        inputSchema: { text: z.string().optional(), window: z.string().optional(), gone: z.boolean().optional(), timeout: z.number().optional() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        if (!a.text && !a.window) return err('give text or window')
        const r = await c.waitFor({ text: a.text, window: a.window, gone: a.gone, timeoutSec: a.timeout })
        return r.ok ? text(r.detail) : err(r.detail)
      }
    )

    s.registerTool(
      'open_app',
      {
        description:
          'Launch an application by NAME (searches the Start menu: "Yandex Music", "Spotify", "Notepad", "Chrome", "Calculator"…) or open a file/URL, wait for its window, focus it, and report what is on screen. If the app is already running it is focused instead. Far more reliable than Win+R or clicking.',
        inputSchema: { name: z.string(), wait: z.number().optional().describe('ms to wait for the window (default 7000)') }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('open_app', a, true)
        if (lp) return lp
        // already running? just focus it
        try {
          const existing = (await h.win.call<WinWindow[]>('windows')).find((w) => w.process.toLowerCase().includes(a.name.toLowerCase()) || w.title.toLowerCase().includes(a.name.toLowerCase()))
          if (existing && !/\.(exe|lnk)$|^https?:/i.test(a.name)) {
            await h.win.call('focus', { hwnd: existing.hwnd })
            return this.result(`focused already-open "${existing.title}" (${existing.process})`, true, 500)
          }
        } catch {}
        try {
          const r = await h.win.call<{ how: string; window: WinWindow | null }>('launch', { name: a.name, wait: a.wait ?? 7000 }, (a.wait ?? 7000) + 15000)
          return this.result(`launched (${r.how})${r.window ? ` → window "${r.window.title}" (${r.window.process})` : ' — no new window detected yet'}`, true, 700)
        } catch (e: any) {
          return err(String(e?.message || e))
        }
      }
    )

    s.registerTool(
      'open_url',
      {
        description: 'Open a URL in the default browser (reuses the running browser: opens a new tab). Waits briefly and reports the active window.',
        inputSchema: { url: z.string() }
      },
      async ({ url }) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('open_url', { url }, true)
        if (lp) return lp
        const target = /^[a-z]+:/i.test(url) ? url : 'https://' + url
        await h.win.call('launch', { name: target, wait: 1200 }, 15000)
        return this.result(`opened ${target}`, true, 1600)
      }
    )

    s.registerTool(
      'focus_window',
      {
        description: 'Bring a window to the foreground by title substring, process name, or hwnd; verifies and reports the active window.',
        inputSchema: { title: z.string().optional(), hwnd: z.number().optional() }
      },
      async (a) => {
        const g = await this.consent()
        if (g) return g
        const lp = this.loop('focus_window', a, true)
        if (lp) return lp
        try {
          await h.win.call('focus', a)
        } catch (e: any) {
          return err(String(e?.message || e) + '. Use jarvis_windows to see what is open.')
        }
        return this.result('focused window', true, 500)
      }
    )

    // ---- pointing --------------------------------------------------------
    s.registerTool(
      'highlight',
      {
        description: 'Outline/point at parts of the screen without speaking (stays ~8 s or until jarvis_clear_highlight). Use find (visible text), mark (item number) or x/y/w/h.',
        inputSchema: { targets: z.array(targetSchema), seconds: z.number().optional() }
      },
      async ({ targets, seconds }) => {
        const g = await this.consent()
        if (g) return g
        const resolved = await this.resolveTargets(targets)
        if (!resolved.length) return err('Nothing to highlight — targets could not be located. Use find:"exact visible text" (item numbers only work for numbers printed by jarvis_screen in this task).')
        h.highlight(resolved, (seconds ?? 8) * 1000)
        return text(`highlighted ${resolved.length} target(s): ${resolved.map((r) => `${r.label ?? ''} @${Math.round(r.x + r.w / 2)},${Math.round(r.y + r.h / 2)}`.trim()).join('; ')}`)
      }
    )
    s.registerTool('clear_highlight', { description: 'Remove screen highlights.', inputSchema: {} }, async () => {
      h.clearHighlight()
      return text('cleared')
    })

    s.registerTool('clipboard_get', { description: 'Read the clipboard text.', inputSchema: {} }, async () => text(await h.win.call('clipboard_get')))
    s.registerTool(
      'clipboard_set',
      { description: 'Put text on the clipboard.', inputSchema: { text: z.string() } },
      async ({ text: t }) => {
        await h.win.call('clipboard_set', { text: t })
        return text('ok')
      }
    )

    // ---- memory ----------------------------------------------------------
    s.registerTool(
      'remember',
      { description: 'Save a durable fact/preference about the user or their world to persistent memory.', inputSchema: { fact: z.string(), tags: z.array(z.string()).optional(), pinned: z.boolean().optional() } },
      async ({ fact, tags, pinned }) => {
        const m = h.memory.add(fact, tags ?? [], pinned ?? false)
        return text(`remembered [${m.id}]`)
      }
    )
    s.registerTool(
      'recall',
      { description: 'Search persistent memory.', inputSchema: { query: z.string() } },
      async ({ query }) => {
        const r = h.memory.search(query)
        return text(r.length ? r.map((m) => `[${m.id}] ${m.text}`).join('\n') : 'nothing found')
      }
    )
    s.registerTool(
      'forget',
      { description: 'Delete a memory by id (from jarvis_recall).', inputSchema: { id: z.string() } },
      async ({ id }) => {
        h.memory.delete(id)
        return text('forgotten')
      }
    )

    // ---- routines --------------------------------------------------------
    s.registerTool(
      'routine_save',
      {
        description:
          'Create or REPLACE a voice routine: when the user says one of `phrases` (after the wake word) the steps run instantly without the model. Re-saving an existing name edits it.',
        inputSchema: { name: z.string(), phrases: z.array(z.string()).min(1), steps: z.array(stepSchema).min(1) }
      },
      async ({ name, phrases, steps }) => {
        const r = h.routines.save1({ name, phrases, steps: toSteps(steps) })
        return text(`routine "${r.name}" saved with ${r.steps.length} steps; triggers: ${r.phrases.join(' | ')}`)
      }
    )
    s.registerTool('routine_list', { description: 'List all routines with their steps.', inputSchema: {} }, async () => {
      const l = h.routines.list()
      return text(l.length ? JSON.stringify(l.map((r) => ({ name: r.name, phrases: r.phrases, steps: r.steps })), null, 1) : 'no routines yet')
    })
    s.registerTool('routine_delete', { description: 'Delete a routine by name.', inputSchema: { name: z.string() } }, async ({ name }) =>
      text(h.routines.delete(name) ? 'deleted' : 'no such routine')
    )
    s.registerTool('routine_run', { description: 'Run a routine now by name.', inputSchema: { name: z.string() } }, async ({ name }) => {
      const r = h.routines.get(name)
      if (!r) return err('no such routine')
      return text(await h.runRoutine(r))
    })

    return s
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
