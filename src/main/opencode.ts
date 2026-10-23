import { spawn, ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { app } from 'electron'
import type { ChatItem, ConnectorConfig, ConnectorStatus, ModelInfo, PermissionRequest, ProviderInfo, Settings, ToolEvent } from '../shared/types'
import { splitCommand } from '../shared/connectors'
import { JARVIS_PROMPT } from './agent-prompt'
import { dataDir, ThreadStore } from './store'

const FREE_DEFAULTS: ModelInfo[] = [
  { id: 'opencode/glm-5.3-flash-free', name: 'GLM 5.3 Flash (free)', free: true, vision: true, provider: 'opencode' },
  { id: 'opencode/deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash (free)', free: true, vision: true, provider: 'opencode' },
  { id: 'opencode/nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL (free)', free: true, vision: true, provider: 'opencode' }
]

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

function binaryPath(): string {
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'), join(process.resourcesPath, 'node_modules')]
    : [join(app.getAppPath(), 'node_modules')]
  for (const r of roots) {
    for (const pkg of ['opencode-windows-x64', 'opencode-ai']) {
      const p = join(r, pkg, 'bin', 'opencode.exe')
      if (existsSync(p)) return p
    }
  }
  return 'opencode' // fall back to PATH
}

/** tools of connected services (MCP): reads run freely, anything that writes/sends/deletes asks first (unless full-auto) */
function connectorPermissions(mode: Settings['permissionMode'], ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    out[`${id}_*`] = 'ask'
    if (mode !== 'ask') for (const w of ['get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'resolve', 'ask', 'describe', 'view', 'check', 'whoami', 'suggest']) out[`${id}_*${w}*`] = 'allow'
  }
  return out
}

function permissionConfig(mode: Settings['permissionMode'], connectorIds: string[] = []) {
  if (mode === 'full-auto') return 'allow'
  const risky = ['rm *', 'del *', 'rd *', 'rmdir *', 'Remove-Item*', 'format *', 'shutdown*', 'Stop-Computer*', 'Restart-Computer*', 'reg delete*', 'taskkill*', 'Stop-Process*', 'diskpart*', 'git push*--force*', 'git reset --hard*']
  const bash: Record<string, string> = { '*': mode === 'ask' ? 'ask' : 'allow' }
  for (const r of risky) bash[r] = 'ask'
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    todowrite: 'allow',
    task: 'allow',
    external_directory: 'allow',
    edit: mode === 'ask' ? 'ask' : 'allow',
    bash,
    ...connectorPermissions(mode, connectorIds)
  }
}

export interface OpencodeInit {
  mcpUrl: string
  mcpToken: string
}

export class Opencode extends EventEmitter {
  private proc: ChildProcess | null = null
  private base = ''
  private sessionId = ''
  private abortSSE: AbortController | null = null
  private roles = new Map<string, string>()
  private partItem = new Map<string, string>()
  private partType = new Map<string, string>()
  private items = new Map<string, ChatItem>()
  private pendingPerms = new Map<string, { kind: 'permission' | 'question'; sessionID: string }>()
  private busy = false
  private restarts = 0
  lastEventAt = Date.now()
  private currentVia: 'voice' | 'text' = 'text'
  status: 'starting' | 'ready' | 'error' | 'stopped' | 'sleeping' = 'stopped'
  private sleepTimer: NodeJS.Timeout | null = null
  private waking: Promise<void> | null = null
  private modelCache: ModelInfo[] = [...FREE_DEFAULTS]

  constructor(
    private getSettings: () => Settings,
    private init: OpencodeInit,
    private threads: ThreadStore
  ) {
    super()
  }

  get isBusy() {
    return this.busy
  }
  get sessionID() {
    return this.sessionId
  }

  private activeConnectors(): ConnectorConfig[] {
    return (this.getSettings().connectors ?? []).filter((c) => c.enabled && c.id && (c.type === 'remote' ? !!c.url : !!c.command))
  }

  /** user connectors → opencode `mcp` entries */
  private connectorEntries(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const c of this.activeConnectors()) {
      if (c.id === 'jarvis') continue
      if (c.type === 'local') {
        out[c.id] = { type: 'local', command: splitCommand(c.command!), environment: c.env, enabled: true, timeout: 60000 }
      } else {
        const oauth = c.noOAuth ? false : c.oauth && (c.oauth.clientId || c.oauth.scope) ? { ...c.oauth, callbackPort: 19876 } : {}
        out[c.id] = { type: 'remote', url: c.url, headers: c.headers, enabled: true, oauth, timeout: 60000 }
      }
    }
    return out
  }

  private cfgJson() {
    const s = this.getSettings()
    return {
      $schema: 'https://opencode.ai/config.json',
      model: s.model,
      small_model: 'opencode/deepseek-v4.1-flash-free',
      default_agent: 'jarvis',
      autoupdate: false,
      lsp: false,
      formatter: false,
      share: 'disabled',
      snapshot: false,
      permission: permissionConfig(s.permissionMode, this.activeConnectors().map((c) => c.id)),
      // user-defined OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, any gateway…)
      ...(s.customProvider.enabled && s.customProvider.baseURL
        ? {
            provider: {
              custom: {
                npm: '@ai-sdk/openai-compatible',
                name: s.customProvider.name || 'Custom',
                options: { baseURL: s.customProvider.baseURL, ...(s.customProvider.apiKey ? { apiKey: s.customProvider.apiKey } : {}) },
                models: Object.fromEntries(
                  s.customProvider.models
                    .split(',')
                    .map((m) => m.trim())
                    .filter(Boolean)
                    .map((m) => [m, { name: m }])
                )
              }
            }
          }
        : {}),
      agent: {
        vision: {
          description: 'Screen reader: answers questions about an attached screenshot',
          mode: 'subagent',
          hidden: true,
          prompt: 'You are a precise screen reader. You receive a screenshot of a Windows desktop and a question. Answer concisely and concretely from what is visible: read exact numbers/text, name apps and windows, point out where things are (e.g. "top-right", "below the video"). If something is not visible, say so. Never call tools.',
          // tools must stay enabled in the request: the opencode free tier answers 403 "free tier can only be used from within OpenCode" to tool-less calls
          steps: 1
        },
        jarvis: {
          description: 'Jarvis voice assistant',
          mode: 'primary',
          prompt: JARVIS_PROMPT,
          // fewer tool schemas = shorter prompt = faster first token; Jarvis has its own questions/planning
          tools: { question: false, task: false, todowrite: false, todoread: false, patch: false },
          steps: 60
        }
      },
      mcp: {
        jarvis: {
          type: 'remote',
          url: this.init.mcpUrl,
          headers: { Authorization: `Bearer ${this.init.mcpToken}` },
          enabled: true,
          oauth: false,
          timeout: 240000
        },
        ...this.connectorEntries()
      }
    }
  }

  private async req<T = any>(method: string, path: string, body?: unknown, timeout = 30000): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    })
    if (!res.ok) throw new Error(`opencode ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  async start() {
    if (this.proc) return
    this.setStatus('starting')
    try {
      const port = await freePort()
      this.base = `http://127.0.0.1:${port}`
      const root = join(dataDir(), 'opencode')
      for (const d of ['data', 'config', 'state', 'cache']) mkdirSync(join(root, d), { recursive: true })
      // the old Open Computer Use skill is replaced by Jarvis' native window tools
      rmSync(join(root, 'config', 'opencode', 'skills', 'open-computer-use'), { recursive: true, force: true })
      const cwd = this.getSettings().cwd || join(app.getPath('home'), 'Jarvis')
      mkdirSync(cwd, { recursive: true })
      const env = {
        ...process.env,
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_STATE_HOME: join(root, 'state'),
        XDG_CACHE_HOME: join(root, 'cache'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(this.cfgJson()),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        // Jarvis is its own assistant: don't inherit the user's Claude Code skills / CLAUDE.md / prompts
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
        // Bun's low-memory mode: smaller heap, more frequent GC (the server is mostly idle I/O)
        BUN_OPTIONS: [process.env.BUN_OPTIONS, '--smol'].filter(Boolean).join(' ')
      }
      const bin = binaryPath()
      const p = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd, env, windowsHide: true })
      this.proc = p
      p.stdout.on('data', (d) => console.log('[opencode]', d.toString().trim()))
      p.stderr.on('data', (d) => console.warn('[opencode]', d.toString().trim()))
      p.on('exit', (code) => {
        console.warn('[opencode] exited', code)
        this.proc = null
        if (this.status === 'stopped' || this.status === 'sleeping') return
        this.setStatus('error', 'opencode exited')
        // self-heal: restart with a short back-off (max 4 times in a row)
        if (this.restarts < 4) {
          const delay = 1500 * ++this.restarts
          setTimeout(() => {
            if (this.status === 'error' && !this.proc) void this.start()
          }, delay)
        }
      })
      await this.waitHealthy()
      await this.applyAuth()
      await this.ensureSession()
      this.emit('reset') // the UI may have loaded its (empty) history before the session existed
      void this.listen()
      this.restarts = 0
      this.setStatus('ready')
      this.armSleep()
      void this.listModels(true) // real capability flags (vision!) of the models, not just the built-in defaults
      void this.providers().catch(() => {}) // prefetch the catalogue so the Settings page opens instantly
    } catch (e: any) {
      console.error('[opencode] start failed', e)
      this.setStatus('error', String(e?.message || e))
    }
  }

  private async waitHealthy() {
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      try {
        const r = await fetch(this.base + '/global/health', { signal: AbortSignal.timeout(1500) })
        if (r.ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('opencode did not start in time')
  }

  async applyAuth() {
    const key = this.getSettings().apiKey.trim()
    if (!key) return
    await this.req('PUT', '/auth/opencode', { type: 'api', key })
  }

  private async sessionExists(id: string) {
    try {
      return !!(await this.req('GET', `/session/${id}`))?.id
    } catch {
      return false
    }
  }

  private async ensureSession() {
    // one-time migration of the old single-session file into the thread list
    const legacy = join(dataDir(), 'session.json')
    if (!this.threads.state().threads.length && existsSync(legacy)) {
      try {
        const id = JSON.parse(readFileSync(legacy, 'utf8')).id as string
        if (id && (await this.sessionExists(id))) this.threads.add(id, 'Earlier conversation')
      } catch {}
    }
    const cur = this.threads.current
    if (cur && (await this.sessionExists(cur.sessionId))) {
      this.sessionId = cur.sessionId
      return
    }
    await this.newThread()
  }

  /** Start a brand-new conversation (fresh opencode session) and make it current. */
  async newThread() {
    const s = await this.req('POST', '/session', {})
    this.threads.add(s.id)
    this.useSession(s.id)
  }

  async switchThread(threadId: string) {
    const t = this.threads.get(threadId)
    if (!t) return
    if (!(await this.sessionExists(t.sessionId))) {
      this.threads.remove(threadId)
      return this.ensureSession().then(() => this.useSession(this.sessionId))
    }
    this.threads.select(threadId)
    this.useSession(t.sessionId)
  }

  async deleteThread(threadId: string) {
    const t = this.threads.get(threadId)
    if (!t) return
    const wasCurrent = this.threads.current?.id === threadId
    try {
      await this.req('DELETE', `/session/${t.sessionId}`)
    } catch {}
    this.threads.remove(threadId)
    if (wasCurrent) {
      if (this.threads.current) await this.switchThread(this.threads.current.id)
      else await this.newThread()
    }
  }

  private useSession(id: string) {
    this.sessionId = id
    this.items.clear()
    this.partItem.clear()
    this.partType.clear()
    this.roles.clear()
    this.setBusy(false)
    this.emit('reset')
  }

  /** Reload the persisted conversation into ChatItems (for the UI after restart). */
  async newSession() {
    await this.newThread()
  }

  async history(): Promise<ChatItem[]> {
    if (!this.sessionId) return []
    try {
      const msgs = await this.req<any[]>('GET', `/session/${this.sessionId}/message`)
      const out: ChatItem[] = []
      for (const m of msgs) {
        const at = m.info?.time?.created ?? Date.now()
        if (m.info.role === 'user') {
          const text = (m.parts || []).filter((p: any) => p.type === 'text' && !p.synthetic).map((p: any) => p.text).join('\n')
          if (text && !text.startsWith('[auto-continue]')) out.push({ id: m.info.id, kind: 'user', text, at, via: 'text' })
        } else {
          for (const p of m.parts || []) {
            if (p.type === 'reasoning' && p.text?.trim()) out.push({ id: p.id, kind: 'thinking', text: p.text, at, done: true, ms: p.time?.end && p.time?.start ? p.time.end - p.time.start : undefined })
            else if (p.type === 'text' && p.text?.trim()) out.push({ id: p.id, kind: 'assistant', text: p.text, at, done: true })
            else if (p.type === 'tool' && !String(p.tool).endsWith('jarvis_say')) out.push({ id: p.id, kind: 'tool', at, tool: this.toolEvent(p) })
          }
        }
      }
      return out.slice(-80)
    } catch {
      return []
    }
  }

  private async listen() {
    this.abortSSE?.abort()
    const ac = new AbortController()
    this.abortSSE = ac
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(this.base + '/event', { signal: ac.signal })
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('')
            if (!data) continue
            try {
              this.onEvent(JSON.parse(data))
            } catch (e) {
              console.warn('[opencode] bad event', e)
            }
          }
        }
      } catch (e: any) {
        if (ac.signal.aborted) return
        console.warn('[opencode] event stream error', e?.message)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  private upsert(item: ChatItem) {
    this.items.set(item.id, item)
    this.emit('chat', item)
  }

  private toolEvent(part: any): ToolEvent {
    const st = part.state || {}
    return {
      id: part.id,
      tool: part.tool,
      title: st.title,
      status: st.status || 'pending',
      input: st.input,
      startedAt: st.time?.start,
      ms: st.time?.end && st.time?.start ? st.time.end - st.time.start : undefined,
      output: typeof st.output === 'string' ? st.output.slice(0, 2000) : typeof st.error === 'string' ? st.error.slice(0, 600) : undefined
    }
  }

  private onEvent(ev: any) {
    const p = ev.properties ?? ev.data ?? {}
    if (!p.sessionID || p.sessionID === this.sessionId) this.lastEventAt = Date.now()
    if (p.sessionID && this.sessionId && p.sessionID !== this.sessionId && !ev.type?.startsWith('permission') && !ev.type?.startsWith('question')) return
    if (ev.type === 'session.updated' && p.info?.id && p.info.title) this.threads.setTitleFromSession(p.info.id, p.info.title)
    switch (ev.type) {
      case 'message.updated': {
        const info = p.info
        if (info?.id) this.roles.set(info.id, info.role)
        if (info?.role === 'assistant' && info.error && info.error.name !== 'MessageAbortedError') {
          this.emit('error', this.errorText(info.error))
        }
        break
      }
      case 'message.part.updated': {
        const part = p.part
        if (!part) break
        this.partType.set(part.id, part.type)
        const role = this.roles.get(part.messageID)
        if (part.type === 'text') {
          if (role === 'user' || part.synthetic) break
          const existing = this.items.get(part.id)
          this.upsert({ id: part.id, kind: 'assistant', text: part.text || '', at: (existing as any)?.at ?? Date.now(), done: !!part.time?.end })
        } else if (part.type === 'reasoning') {
          if (role === 'user') break
          const existing = this.items.get(part.id)
          const ms = part.time?.end && part.time?.start ? part.time.end - part.time.start : undefined
          this.upsert({ id: part.id, kind: 'thinking', text: part.text || '', at: (existing as any)?.at ?? Date.now(), done: !!part.time?.end, ms })
        } else if (part.type === 'tool') {
          if (String(part.tool).endsWith('jarvis_say')) break
          const existing = this.items.get(part.id)
          this.upsert({ id: part.id, kind: 'tool', at: (existing as any)?.at ?? Date.now(), tool: this.toolEvent(part) })
        }
        break
      }
      case 'message.part.delta': {
        if (p.field !== 'text') break
        if (this.partType.get(p.partID) === 'reasoning') {
          const th = this.items.get(p.partID)
          this.upsert(th && th.kind === 'thinking' ? { ...th, text: th.text + p.delta } : { id: p.partID, kind: 'thinking', text: p.delta, at: Date.now(), done: false })
          break
        }
        if (this.partType.get(p.partID) !== 'text') break
        const it = this.items.get(p.partID)
        if (it && it.kind === 'assistant') {
          this.upsert({ ...it, text: it.text + p.delta })
        } else if (this.roles.get(p.messageID) === 'assistant') {
          this.upsert({ id: p.partID, kind: 'assistant', text: p.delta, at: Date.now(), done: false })
        }
        break
      }
      case 'session.status': {
        const t = p.status?.type
        if (t === 'busy' || t === 'retry') this.setBusy(true)
        if (t === 'retry') this.onRetry(p.status)
        else if (t === 'idle') this.finishTurn()
        break
      }
      case 'session.idle':
        this.finishTurn()
        break
      case 'session.error': {
        if (p.error?.name !== 'MessageAbortedError') this.emit('error', this.errorText(p.error))
        this.finishTurn()
        break
      }
      case 'permission.asked':
      case 'permission.updated': {
        const d = p.id ? p : p.data
        if (!d?.id) break
        this.pendingPerms.set(d.id, { kind: 'permission', sessionID: d.sessionID })
        const cmd = d.metadata?.command || d.metadata?.description || (d.patterns || []).join(', ')
        const req: PermissionRequest = {
          id: d.id,
          kind: 'permission',
          title: d.permission ? `${d.permission}` : d.title || 'Permission',
          detail: String(cmd || d.title || '')
        }
        this.emit('permission', req)
        break
      }
      case 'question.asked': {
        const d = p.id ? p : p.data
        if (!d?.id) break
        this.pendingPerms.set(d.id, { kind: 'question', sessionID: d.sessionID })
        const q = d.questions?.[0]
        this.emit('permission', {
          id: d.id,
          kind: 'question',
          title: q?.question || 'Question',
          options: (q?.options || []).map((o: any) => o.label),
          multiple: !!q?.multiple
        } as PermissionRequest)
        break
      }
    }
  }

  private errorText(err: any): string {
    if (!err) return 'Unknown error'
    return err.data?.message || err.message || err.name || JSON.stringify(err).slice(0, 200)
  }

  private setBusy(b: boolean) {
    if (this.busy === b) return
    this.busy = b
    this.emit('busy', b)
  }

  /** true when the last turn ended because the user stopped it (so nothing should auto-continue it) */
  aborted = false
  private limitReported = false

  /**
   * The provider refused the request and opencode is retrying. Short retries are fine; a quota (free tier used up)
   * or a retry minutes/hours away would leave Jarvis "working" in silence, so stop the turn and say why.
   */
  private onRetry(st: any) {
    const wait = typeof st?.next === 'number' ? st.next - Date.now() : 0
    const quota = st?.action?.reason === 'free_tier_limit' || /free usage|quota|limit (reached|exceeded)|insufficient (credit|balance)/i.test(String(st?.message ?? ''))
    if (!quota && wait < 60_000) return
    if (this.limitReported) return
    this.limitReported = true
    this.emit('limit', { message: String(st?.message ?? ''), waitMs: Math.max(0, wait), quota, free: st?.action?.reason === 'free_tier_limit' })
    void this.abort().catch(() => {})
  }

  private finishTurn() {
    if (!this.isBusy) return // session.status:idle and session.idle both arrive: end a turn only once
    for (const [, it] of this.items) if ((it.kind === 'assistant' || it.kind === 'thinking') && !it.done) this.upsert({ ...it, done: true })
    this.setBusy(false)
    this.emit('turnEnd')
  }

  private setStatus(s: Opencode['status'], message?: string) {
    this.status = s
    this.emit('status', s, message)
  }

  async send(text: string, system: string, via: 'voice' | 'text') {
    await this.wake()
    if (this.status !== 'ready') throw new Error('Agent is not ready: ' + this.status)
    this.armSleep()
    this.currentVia = via
    this.aborted = false
    this.limitReported = false
    const [providerID, ...rest] = this.getSettings().model.split('/')
    const cur = this.threads.current
    if (cur) this.threads.touch(cur.id, text.replace(/\s+/g, ' ').slice(0, 48))
    this.lastEventAt = Date.now()
    this.setBusy(true)
    this.emit('turnStart', via)
    await this.req('POST', `/session/${this.sessionId}/prompt_async`, {
      agent: 'jarvis',
      model: { providerID, modelID: rest.join('/') },
      system,
      parts: [{ type: 'text', text }]
    })
  }

  get lastVia() {
    return this.currentVia
  }

  async abort() {
    this.aborted = true
    if (!this.sessionId) return
    try {
      await this.req('POST', `/session/${this.sessionId}/abort`)
    } catch {}
    this.finishTurn()
  }

  async replyPermission(id: string, answer: 'once' | 'always' | 'reject' | string[]) {
    const meta = this.pendingPerms.get(id)
    this.pendingPerms.delete(id)
    if (!meta) return
    if (meta.kind === 'permission') {
      await this.req('POST', `/permission/${id}/reply`, { reply: answer as string })
    } else if (Array.isArray(answer)) {
      await this.req('POST', `/question/${id}/reply`, { answers: [answer] })
    } else {
      await this.req('POST', `/question/${id}/reject`, {})
    }
  }

  /** Free models first; with an API key, fetches everything the account can use. */
  async listModels(fetchAll: boolean): Promise<ModelInfo[]> {
    if (!fetchAll || this.status !== 'ready') return this.modelCache
    try {
      const cfg = await this.req<any>('GET', '/config/providers')
      const out: ModelInfo[] = []
      // every connected provider (opencode Zen, OpenRouter, OpenAI, a custom endpoint…)
      for (const prov of cfg.providers || []) {
        for (const m of Object.values<any>(prov.models || {})) {
          out.push({
            id: `${prov.id}/${m.id}`,
            name: m.name || m.id,
            free: /free$/.test(m.id) || (m.cost?.input === 0 && m.cost?.output === 0 && prov.id === 'opencode'),
            // the opencode server reports capabilities.input.image (models.dev's `modalities` is the raw catalogue form)
            vision: !!(m.capabilities?.input?.image || m.modalities?.input?.includes('image')),
            provider: prov.id
          })
        }
      }
      if (out.length) {
        out.sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name))
        this.modelCache = out
      }
    } catch (e) {
      console.warn('[opencode] model list failed', e)
    }
    return this.modelCache
  }

  /** All providers opencode knows (≈230), flagged with whether a key is connected. */
  private providerCache: ProviderInfo[] | null = null

  async providers(force = false): Promise<ProviderInfo[]> {
    if (this.status !== 'ready') return []
    if (this.providerCache && !force) return this.providerCache
    const r = await this.req<any>('GET', '/provider', undefined, 60000)
    const connected = new Set<string>(r.connected || [])
    const list: ProviderInfo[] = (r.all || []).map((p: any) => ({
      id: p.id,
      name: p.name || p.id,
      env: p.env || [],
      connected: connected.has(p.id),
      models: Object.keys(p.models || {}).length
    }))
    if (this.getSettings().customProvider.enabled && !list.some((p) => p.id === 'custom')) list.unshift({ id: 'custom', name: this.getSettings().customProvider.name || 'Custom', env: [], connected: true, models: 0 })
    this.providerCache = list
    return list
  }

  /** state of every MCP server (ours + connectors) */
  async mcpStatus(): Promise<Record<string, ConnectorStatus>> {
    if (this.status !== 'ready') return {}
    try {
      const r = await this.req<Record<string, any>>('GET', '/mcp', undefined, 20000)
      const out: Record<string, ConnectorStatus> = {}
      for (const [k, v] of Object.entries(r || {})) out[k] = { status: v?.status ?? 'unknown', error: v?.error }
      return out
    } catch {
      return {}
    }
  }

  /** OAuth sign-in for a remote connector: opencode opens the browser and waits for the redirect */
  async mcpAuthenticate(name: string): Promise<ConnectorStatus> {
    const r = await this.req<any>('POST', `/mcp/${encodeURIComponent(name)}/auth/authenticate`, undefined, 300000)
    return { status: r?.status ?? 'unknown', error: r?.error }
  }

  async mcpReconnect(name: string) {
    await this.req('POST', `/mcp/${encodeURIComponent(name)}/disconnect`).catch(() => {})
    await this.req('POST', `/mcp/${encodeURIComponent(name)}/connect`, undefined, 90000)
  }

  async mcpSignOut(name: string) {
    await this.req('DELETE', `/mcp/${encodeURIComponent(name)}/auth`).catch(() => {})
  }

  async connectProvider(id: string, key: string) {
    await this.req('PUT', `/auth/${encodeURIComponent(id)}`, { type: 'api', key })
    await this.req('POST', '/instance/dispose').catch(() => {}) // make the running instance pick the new credentials up
    this.providerCache = null
  }

  async disconnectProvider(id: string) {
    await this.req('DELETE', `/auth/${encodeURIComponent(id)}`)
    await this.req('POST', '/instance/dispose').catch(() => {})
    this.providerCache = null
  }

  isVision(modelId: string) {
    return !!this.modelCache.find((m) => m.id === modelId)?.vision
  }

  /** 'auto' (and the old built-in default) = the model Jarvis already runs on when it can see images, else the free VL helper. */
  pickVisionModel(): string {
    const cfg = this.getSettings().visionModel
    const auto = !cfg || cfg === 'auto' || cfg === 'opencode/nemotron-3.5-super-vl-free'
    if (!auto) return cfg
    const cur = this.getSettings().model
    return this.isVision(cur) ? cur : 'opencode/nemotron-3.5-super-vl-free'
  }

  /** One-shot question about a screenshot, answered by a vision-capable model in a throwaway session. */
  async visionQuery(jpeg: Buffer, question: string): Promise<string> {
    await this.wake()
    if (this.status !== 'ready') throw new Error('agent not ready')
    const [providerID, ...rest] = this.pickVisionModel().split('/')
    const s = await this.req('POST', '/session', { title: 'vision' })
    try {
      const r = await this.req<any>(
        'POST',
        `/session/${s.id}/message`,
        {
          agent: 'vision',
          model: { providerID, modelID: rest.join('/') },
          parts: [
            { type: 'text', text: question },
            { type: 'file', mime: 'image/jpeg', filename: 'screen.jpg', url: 'data:image/jpeg;base64,' + jpeg.toString('base64') }
          ]
        },
        120000
      )
      const out = (r.parts || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim()
      return out || '(the vision model returned nothing)'
    } finally {
      this.req('DELETE', `/session/${s.id}`).catch(() => {})
    }
  }

  async restart() {
    await this.stop()
    this.status = 'stopped'
    await this.start()
  }

  /**
   * The agent server is the biggest process (~300–500 MB). After N idle minutes it is shut down; the conversation is on disk,
   * so wake() restarts it in a few seconds — the assistant already wakes it when the wake word is heard.
   */
  private armSleep() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    const min = this.getSettings().agentIdleMinutes
    if (!min || this.status !== 'ready') return
    this.sleepTimer = setTimeout(() => {
      if (this.isBusy || this.pendingPerms.size || Date.now() - this.lastEventAt < min * 60_000) return this.armSleep()
      console.log('[opencode] idle — unloading the agent server')
      void this.stop().then(() => this.setStatus('sleeping'))
    }, min * 60_000)
  }

  /** Make sure the agent server runs (restarts it after an idle unload). */
  async wake(): Promise<void> {
    if (this.status === 'ready') return this.armSleep()
    if (!this.waking) {
      this.waking = (async () => {
        if (!this.proc && this.status !== 'starting') await this.start()
        const t0 = Date.now()
        while (this.status !== 'ready' && Date.now() - t0 < 45_000) {
          if (this.status === 'error' && !this.proc) break
          await new Promise((r) => setTimeout(r, 200))
        }
      })().finally(() => (this.waking = null))
    }
    return this.waking
  }

  async stop() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.abortSSE?.abort()
    this.setStatus('stopped')
    try {
      this.proc?.kill()
    } catch {}
    this.proc = null
  }
}
