import { EventEmitter } from 'events'
import { app, screen } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppStatus, AssistantState, ChatItem, HighlightTarget, PermissionRequest, Routine, RoutineStep, ToolEvent } from '../shared/types'
import { phraseScore, normalize } from '../shared/textmatch'
import { SettingsStore, MemoryStore, RoutineStore, ThreadStore, dataDir } from './store'
import { Opencode } from './opencode'
import { JarvisMcp, Hub } from './mcp'
import { WinBridge, hasNative } from './win'
import { SpeechEngine, SpeechEvent } from './speech/engine'
import { Tts, splitSentences, detectLang, speakable } from './tts'
import { Overlay } from './overlay'
import { XttsSidecar } from './xtts'
import { buildSystemExtra } from './agent-prompt'
import { matchFast } from './fast-commands'
import { pathsFor } from './models'

let idSeq = 0
const uid = () => `x${Date.now().toString(36)}${(idSeq++).toString(36)}`

export interface PlayRequest {
  id: string
  wav: Buffer
  fx: boolean
  volume: number
}

/**
 * Central coordinator: wires speech engine → routines / agent → TTS, owns the assistant state machine,
 * and implements the Hub that the MCP tool server calls back into.
 */
export class Assistant extends EventEmitter implements Hub {
  readonly settingsStore = new SettingsStore()
  readonly memory = new MemoryStore()
  readonly routines = new RoutineStore()
  readonly threads = new ThreadStore()
  readonly win = new WinBridge()
  /** the native helper serves requests concurrently, so one process does both jobs; the PowerShell fallback needs a second one */
  readonly scanWin = hasNative() ? this.win : new WinBridge()
  readonly overlay = new Overlay()
  private grantedThreads = new Set<string>()
  readonly tmpDir = join(app.getPath('temp'), 'jarvis')
  readonly speech: SpeechEngine
  readonly tts: Tts
  readonly xtts = new XttsSidecar()
  readonly mcp: JarvisMcp
  opencode!: Opencode

  state: AssistantState = 'idle'
  private speakingDepth = 0
  private speakAbort = { aborted: false }
  private playResolvers = new Map<string, () => void>()
  private askResolve: ((a: string) => void) | null = null
  private askId = ''
  private pendingConfirms = new Map<string, (ok: boolean) => void>()
  private sayCalledThisTurn = false
  private lastAssistantText = ''
  private lastWasVoice = false
  private busyTranscribing = false
  private commandListening = false
  private sttWatchdog: NodeJS.Timeout | null = null
  private userSpeaking = false
  private bannerMessage = ''
  private activity = ''
  private lastLang: 'ru' | 'en' = 'ru'
  private lastSpeechAt = 0
  private controlTimer: NodeJS.Timeout | null = null
  private controlOn = false
  private controlPrompt: Promise<boolean> | null = null
  private seenTools = new Set<string>()
  private stepCount = 0
  private liveSteps: NonNullable<AppStatus['steps']> = []
  private turnStartedAt = 0
  private lastItem: { kind: string; text?: string } = { kind: '' }
  private turnErrored = false
  private nudges = 0
  private lastSystem = ''
  private lastVia: 'voice' | 'text' = 'text'
  private watchdog: NodeJS.Timeout | null = null
  private ackCache = new Map<string, Buffer>()
  private lastAck = ''
  private fishWarned = false
  private sayChain: Promise<void> = Promise.resolve()
  private sayEpoch = 0
  private askQueue: Promise<string> = Promise.resolve('')
  private askQuestion = ''
  private ackPreparing = false

  constructor() {
    super()
    const base = dataDir()
    this.speech = new SpeechEngine(base, () => this.settings())
    this.tts = new Tts(
      { piperExe: pathsFor(base).piperExe, voice: (id) => pathsFor(base).voice(id) },
      join(this.tmpDir, 'tts'),
      this.xtts,
      () => ({ mode: this.settings().voiceMode, serverUrl: this.settings().ttsServerUrl.trim() || DEFAULT_SETTINGS.ttsServerUrl, installId: this.settings().installId, apiKey: this.settings().fishApiKey.trim(), model: this.settings().fishModel.trim() || 's2.1-pro-free', voiceRu: this.settings().fishVoiceRu.trim() || DEFAULT_SETTINGS.fishVoiceRu, voiceEn: this.settings().fishVoiceEn.trim() || DEFAULT_SETTINGS.fishVoiceEn })
    )
    this.xtts.idleMinutes = this.settings().cloneIdleMinutes
    this.xtts.on('state', (st) => {
      this.emitStatus()
      if (st === 'ready') void this.prepareAcks()
    })
    this.mcp = new JarvisMcp(this)
  }

  // ---------------------------------------------------------------- Hub
  settings = () => this.settingsStore.get()
  isVision = () => this.opencode?.isVision(this.settings().model) ?? false
  askVision = (jpeg: Buffer, q: string) => this.opencode.visionQuery(jpeg, q)

  async init() {
    await this.mcp.start()
    // one-time migration: existing installs move to the lighter, more accurate English recogniser
    if (!this.settings().sttV2) {
      const hasParakeet = existsSync(pathsFor(dataDir()).parakeetDir)
      this.settingsStore.set({ sttV2: true, ...(hasParakeet ? { sttModel: 'parakeet-en' as const } : {}) })
    }
    // one-time: name this installation (free voice server limits) and pick the voice source from what was configured before
    {
      const f = this.settings()
      if (!f.installId) this.settingsStore.set({ installId: randomUUID() })
      if (!f.voiceModeSet) {
        const mode = f.voiceRu.startsWith('fish:') ? (f.fishApiKey ? 'custom' : 'server') : 'local'
        this.settingsStore.set({ voiceModeSet: true, voiceMode: mode })
      }
    }
    // a Fish Audio key with voice ids configured: make Fish the speaking voice (still switchable in Settings)
    {
      const f = this.settings()
      if (f.fishApiKey && f.fishVoiceRu && f.fishVoiceEn && !f.fishOffered) {
        this.settingsStore.set({ fishOffered: true, voiceRu: 'fish:ru', voiceEn: 'fish:en' })
      }
    }
    // first run with the cloned-voice engine installed: make it the default voice (still switchable in Settings)
    if (this.xtts.available() && !this.settings().cloneOffered) {
      // only switches when the user already chose local voices; the free server stays the default otherwise
      const local = this.settings().voiceMode === 'local'
      this.settingsStore.set({ cloneOffered: true, ...(local ? { voiceRu: 'xtts:jarvis', voiceEn: 'xtts:jarvis' } : {}) })
    }
    this.opencode = new Opencode(() => this.settings(), { mcpUrl: this.mcp.url, mcpToken: this.mcp.token }, this.threads)
    this.opencode.on('reset', () => this.emit('chatReset'))
    this.opencode.on('chat', (item: ChatItem) => {
      if (item.kind === 'assistant') this.lastAssistantText = item.text
      if (item.kind === 'tool') this.onTool(item.tool)
      // what did the model do last? (a turn that ends on a tool result / bare reasoning / "let me write the script:" stalled)
      if (item.kind === 'tool') this.lastItem = { kind: /jarvis_(say|ask)$/.test(item.tool.tool) ? 'say' : 'tool' }
      else if (item.kind === 'thinking') this.lastItem = { kind: 'thinking' }
      else if (item.kind === 'assistant') this.lastItem = { kind: 'assistant', text: item.text }
      this.emit('chat', item)
    })
    this.opencode.on('status', () => this.emitStatus())
    this.opencode.on('permission', (r: PermissionRequest) => this.onAgentPermission(r))
    this.opencode.on('error', (msg: string) => {
      this.turnErrored = true
      this.emit('chat', { id: uid(), kind: 'system', text: `⚠ ${msg}`, at: Date.now() } satisfies ChatItem)
      this.setState('error')
      setTimeout(() => this.state === 'error' && this.setState('idle'), 2500)
    })
    this.opencode.on('turnStart', () => {
      this.sayCalledThisTurn = false
      this.controlPrompt = null
      this.mcp.newTask()
      this.lastAssistantText = ''
      this.seenTools.clear()
      this.stepCount = 0
      this.liveSteps = []
      this.turnStartedAt = Date.now()
      this.turnErrored = false
      this.lastItem = { kind: '' }
      this.lastSpeechAt = Date.now()
      this.setActivity('')
      this.setState('thinking')
    })
    this.opencode.on('turnEnd', () => {
      this.liveSteps = []
      this.turnStartedAt = 0
      this.setActivity('')
      if (this.shouldContinue()) {
        void this.continueTurn()
        return
      }
      this.setControl(false)
      void this.onTurnEnd()
    })
    this.watchdog = setInterval(() => this.checkWatchdog(), 5000)

    this.speech.on('event', (e: SpeechEvent) => void this.onSpeech(e))
    this.speech.start()
    void this.opencode.start()
    this.prewarmVoices()
    this.emitStatus()
  }

  resetFishState() {
    this.fishWarned = false
    for (const k of [...this.ackCache.keys()]) if (k.startsWith('fish:')) this.ackCache.delete(k)
  }

  prewarmVoices() {
    const s = this.settings()
    for (const v of [s.voiceRu, s.voiceEn]) this.tts.warm(v)
    void this.prepareAcks()
    if (!s.voiceRu.startsWith('xtts:') && !s.voiceEn.startsWith('xtts:') && this.xtts.state !== 'off') this.xtts.stop()
  }

  // ---------------------------------------------------------------- status/state
  setState(s: AssistantState) {
    if (this.state === s) return
    this.state = s
    this.emitStatus()
  }

  status(): AppStatus {
    const miss = this.speech.missing()
    const s = this.settings()
    return {
      state: this.state,
      opencode: this.opencode?.status ?? 'starting',
      speech: miss.length ? 'missing-models' : this.speech.ready ? 'ready' : 'loading',
      tts: this.tts.available(s.voiceEn) || this.tts.available(s.voiceRu) ? 'ready' : 'missing-voice',
      listeningForWake: this.speech.ready && s.wakeEnabled,
      clone: this.xtts.state,
      message: this.bannerMessage || undefined,
      activity: this.activity || undefined,
      steps: this.liveSteps.length ? this.liveSteps : undefined,
      turnStartedAt: this.turnStartedAt || undefined,
      controlling: this.controlOn
    }
  }

  emitStatus() {
    this.emit('status', this.status())
  }

  // ---------------------------------------------------------------- speech events
  private async onSpeech(e: SpeechEvent) {
    switch (e.type) {
      case 'ready':
        this.emitStatus()
        break
      case 'error':
        console.error('[speech]', e.error)
        this.bannerMessage = e.soft ? this.bannerMessage : 'Speech engine error'
        this.emitStatus()
        break
      case 'speech':
        this.userSpeaking = e.on
        this.emit('speechActivity', e.on)
        if (e.on && (this.state === 'idle')) this.emit('hint', 'hearing')
        break
      case 'partial':
        this.emit('partial', e.text)
        break
      case 'wake':
        void this.opencode.wake() // the agent may be unloaded while idle: start it while the user is still talking
        this.onWake()
        break
      case 'wakeRejected':
      case 'noResult':
        this.backToRest()
        break
      case 'busy':
        this.busyTranscribing = e.on
        if (this.sttWatchdog) clearTimeout(this.sttWatchdog)
        this.sttWatchdog = null
        if (e.on) {
          this.setState('transcribing')
          // safety net: never stay on "transcribing" longer than a generous decode time
          this.sttWatchdog = setTimeout(() => this.backToRest(), 45000)
        }
        break
      case 'mode':
        this.commandListening = e.mode === 'command'
        if (e.mode === 'wake' && this.askResolve && e.timedOut) this.resolveAsk('')
        if (e.mode === 'wake' && this.state === 'listening') {
          this.setState('idle')
          if (e.timedOut) this.emit('earcon', 'sleep')
        }
        break
      case 'transcript':
        await this.onTranscript(e.text, e.lang, e.viaWake)
        break
    }
  }

  // ---------------------------------------------------------------- wake acknowledgement ("Yes, sir?")
  private static readonly ACK = {
    ru: ['Да, сэр?', 'Слушаю, сэр.', 'К вашим услугам.', 'Я весь внимание, сэр.', 'Чем могу помочь?'],
    en: ['Yes, sir?', 'At your service.', "I'm listening, sir.", 'How may I help?', 'Yes?']
  }
  /** Real lines from the Jarvis recordings (matched by transcript) — instant and authentic when the cloned voice is on. */
  private static readonly REAL_ACK = ['да сэр', 'к вашим услугам сэр', 'всегда к вашим услугам сэр', 'как пожелаете']

  private realAckClips(): { text: string; path: string }[] {
    try {
      const refs = this.xtts.paths().refs
      const meta = JSON.parse(readFileSync(join(refs, 'metadata.json'), 'utf8')) as { file: string; text: string }[]
      return meta
        .filter((m) => Assistant.REAL_ACK.includes(normalize(m.text)))
        .map((m) => ({ text: m.text, path: join(refs, m.file) }))
        .filter((m) => existsSync(m.path))
    } catch {
      return []
    }
  }

  /** Remote (paid/quota) voices keep their acknowledgement lines on disk. */
  private ackDiskPath(voice: string, line: string): string | null {
    if (!voice.startsWith('fish:')) return null
    const id = voice === 'fish:en' ? this.settings().fishVoiceEn : this.settings().fishVoiceRu
    const h = createHash('sha1').update(`${voice}|${id}|${this.settings().fishModel}|${line}`).digest('hex').slice(0, 16)
    return join(dataDir(), 'ack-cache', `${h}.wav`)
  }

  private isAckEcho(text: string): boolean {
    const t = normalize(text)
    if (!t || t.length > 40) return false
    const all = [...Assistant.ACK.ru, ...Assistant.ACK.en, ...Assistant.REAL_ACK]
    return all.some((a) => phraseScore(t, a) >= 0.78)
  }

  /** Pre-synthesise the acknowledgement lines with the active voice so "Yes, sir?" plays with no delay. */
  async prepareAcks() {
    if (this.ackPreparing) return
    this.ackPreparing = true
    try {
      const s = this.settings()
      for (const lang of ['en', 'ru'] as const) {
        const voice = lang === 'ru' ? s.voiceRu : s.voiceEn
        if (!this.tts.available(voice)) continue
        if (voice.startsWith('xtts:') && this.xtts.state !== 'ready') continue
        if (lang === 'ru' && (voice.startsWith('xtts:') || voice.startsWith('fish:')) && this.realAckClips().length) continue // real clips are used instead
        for (const line of Assistant.ACK[lang]) {
          const key = `${voice}|${line}`
          if (this.ackCache.has(key)) continue
          try {
            const disk = this.ackDiskPath(voice, line)
            if (disk && existsSync(disk)) {
              this.ackCache.set(key, readFileSync(disk))
              continue
            }
            const wav = await this.tts.synth(line, voice, s.voiceSpeed, lang)
            this.ackCache.set(key, wav)
            if (disk) {
              mkdirSync(join(dataDir(), 'ack-cache'), { recursive: true })
              writeFileSync(disk, wav)
            }
          } catch {}
        }
      }
    } finally {
      this.ackPreparing = false
    }
  }

  /** Say "Yes, sir?" (or similar) the moment the wake word is confirmed, so the user knows Jarvis heard them. */
  async ack(langHint = '') {
    const s = this.settings()
    if (s.wakeAck === 'off' || !s.voiceEnabled || this.speakingDepth > 0) return
    const lang: 'ru' | 'en' = langHint === 'ru' || langHint === 'en' ? langHint : this.lastLang
    this.lastLang = lang
    const voice = lang === 'ru' ? s.voiceRu : s.voiceEn
    let wav: Buffer | undefined
    let label = ''
    try {
      const real = lang === 'ru' && (voice.startsWith('xtts:') || voice.startsWith('fish:')) ? this.realAckClips() : []
      if (real.length) {
        const pool = real.filter((r) => r.text !== this.lastAck)
        const pick = pool[Math.floor(Math.random() * pool.length)] ?? real[0]
        wav = readFileSync(pick.path)
        label = pick.text
      } else if (this.tts.available(voice)) {
        const lines = Assistant.ACK[lang].filter((l) => l !== this.lastAck)
        const line = lines[Math.floor(Math.random() * lines.length)]
        wav = this.ackCache.get(`${voice}|${line}`)
        if (!wav) {
          // not pre-built yet (cloned voice still loading): use the fast Piper voice rather than make the user wait
          const fb = lang === 'ru' ? 'ru_RU-denis-medium' : 'jarvis-high'
          if (this.tts.available(fb)) wav = await Promise.race([this.tts.synth(line, fb, s.voiceSpeed, lang), new Promise<undefined>((r) => setTimeout(r, 2500))])
        }
        label = line
      }
      if (!wav) return
      this.lastAck = label
      this.speakingDepth++
      this.speech.speaking(true)
      this.emit('subtitle', label)
      await Promise.race([this.play({ id: uid(), wav, fx: s.voiceFx, volume: s.voiceVolume }), new Promise((r) => setTimeout(r, wavMillis(wav!) + 4000))])
    } catch (e) {
      console.warn('[ack] failed', (e as Error).message)
    } finally {
      if (wav) {
        this.speakingDepth = Math.max(0, this.speakingDepth - 1)
        if (this.speakingDepth === 0) {
          this.speech.speaking(false)
          this.emit('subtitle', '')
        }
      }
    }
  }

  /** Leave wake/listening/transcribing without a result: back to listening if a command is awaited, else idle. */
  private backToRest() {
    if (this.state === 'wake' || this.state === 'listening' || this.state === 'transcribing') {
      this.setState(this.commandListening ? 'listening' : 'idle')
    }
  }

  private onWake() {
    if (this.speakingDepth > 0) this.stopSpeaking()
    this.emit('wake')
    this.setState('listening')
  }

  private async onTranscript(text: string, lang: string, viaWake = false) {
    text = text.trim()
    if (this.isAckEcho(text)) {
      // Jarvis heard his own "Yes, sir" through the speakers — not a command
      this.speech.listenFor(this.settings().followupSeconds)
      this.setState('listening')
      return
    }
    if (this.askResolve) {
      if (this.isQuestionEcho(text)) return
      this.resolveAsk(text)
      this.setState('thinking')
      return
    }
    this.commandListening = false
    if (!text || text.length < 2) {
      // only the wake word was said — keep listening for the actual command, and confirm out loud that we heard it
      this.speech.listenFor(this.settings().followupSeconds)
      this.setState('listening')
      if (viaWake) void this.ack(lang)
      return
    }
    if (viaWake && this.settings().wakeAck === 'always') void this.ack(lang)
    await this.handleCommand(text, 'voice', lang)
  }

  /** Entry point for anything the user says or types. */
  async handleCommand(text: string, via: 'voice' | 'text', lang = '') {
    this.lastWasVoice = via === 'voice'
    this.lastLang = lang === 'ru' || /[а-яё]/i.test(text) ? 'ru' : 'en'
    if (this.speakingDepth > 0) this.stopSpeaking()
    if (this.opencode.isBusy) {
      this.mcp.computer.cancel() // a new request supersedes the running one: drop any queued clicks/keys
      await this.opencode.abort()
    }
    this.emit('chat', { id: uid(), kind: 'user', text, at: Date.now(), via } satisfies ChatItem)

    const quick = text.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim()
    if (/^(стоп|отмена|отмени|хватит|замолчи|stop|cancel|abort|enough|never ?mind)$/.test(quick)) {
      this.mcp.computer.cancel()
      await this.opencode.abort()
      this.stopSpeaking()
      this.setState('idle')
      return
    }

    if (/^(новый (диалог|чат|разговор)|начни (с начала|заново|сначала)|забудь (разговор|диалог|всё что было)|new (chat|conversation|thread)|start (over|fresh)|forget (this|the) (chat|conversation))$/.test(quick)) {
      await this.opencode.newThread()
      this.emit('chat', { id: uid(), kind: 'system', text: '✦ New conversation', at: Date.now() } satisfies ChatItem)
      void this.say(/[а-яё]/.test(quick) ? 'Начинаем с чистого листа, сэр.' : 'A clean slate, sir.')
      return
    }

    // instant commands (volume, media keys, desktop) never wait for the model
    const fast = matchFast(text)
    if (fast) {
      try {
        if (fast.kind === 'volume') await this.win.call('volume', { action: fast.action, level: fast.level, step: fast.step })
        else if (fast.kind === 'media') await this.win.call('keys', { keys: { play_pause: 'playpause', next: 'nexttrack', previous: 'prevtrack' }[fast.action] })
        else await this.win.call('desktop', { action: fast.action })
        this.emit('chat', { id: uid(), kind: 'system', text: '⚡ ' + fast.say[this.lastLang === 'ru' ? 0 : 1], at: Date.now() } satisfies ChatItem)
        if (via === 'voice' && fast.kind !== 'media') void this.say(fast.say[this.lastLang === 'ru' ? 0 : 1])
        return
      } catch (e: any) {
        console.warn('[fast] failed, falling back to the agent:', e?.message || e)
      }
    }

    await this.autoThread()

    const r = this.matchRoutine(text)
    if (r) {
      this.emit('chat', { id: uid(), kind: 'system', text: `▶ ${r.name}`, at: Date.now() } satisfies ChatItem)
      this.setState('thinking')
      try {
        await this.runRoutine(r)
      } finally {
        this.setState('idle')
      }
      return
    }

    try {
      const s = this.settings()
      const displays = screen.getAllDisplays().map((d) => `${Math.round(d.size.width * d.scaleFactor)}x${Math.round(d.size.height * d.scaleFactor)}`)
      const system = buildSystemExtra({
        memory: this.memory.promptBlock(),
        routines: this.routines.list(),
        lang: lang === 'ru' || /[а-яё]/i.test(text) ? 'Russian' : 'English',
        via,
        screen: displays.join(' + '),
        vision: this.isVision(),
        time: new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }),
        custom: s.customSystemPrompt,
        connectors: (s.connectors ?? []).filter((c) => c.enabled).map((c) => c.id)
      })
      this.nudges = 0
      this.lastSystem = system
      this.lastVia = via
      await this.opencode.send(text, system, via)
    } catch (e: any) {
      this.emit('chat', { id: uid(), kind: 'system', text: `⚠ ${e?.message || e}`, at: Date.now() } satisfies ChatItem)
      this.setState('idle')
    }
  }

  /** Long pause since the last message → start a fresh conversation so old context doesn't bleed into new tasks. */
  private async autoThread() {
    const mins = this.settings().autoNewThreadMinutes
    const cur = this.threads.current
    if (!mins || !cur || !cur.title) return
    if (Date.now() - cur.updatedAt > mins * 60_000) {
      await this.opencode.newThread()
      this.emit('chat', { id: uid(), kind: 'system', text: '✦ New conversation (long pause)', at: Date.now() } satisfies ChatItem)
    }
  }

  private matchRoutine(text: string): Routine | null {
    let best: { r: Routine; score: number } | null = null
    for (const r of this.routines.list()) {
      for (const p of r.phrases) {
        const sc = phraseScore(text, p)
        if (sc >= 0.82 && sc > (best?.score ?? 0)) best = { r, score: sc }
      }
    }
    return best?.r ?? null
  }

  /**
   * Free models sometimes end a turn in the middle of a job ("Let me write the script:" and then nothing, or right after a
   * tool result). If the last thing the model did was not a final answer, push it once or twice to carry on.
   */
  private shouldContinue(): boolean {
    if (this.opencode.aborted || this.turnErrored || this.nudges >= 2 || this.stepCount < 1) return false
    if (this.askResolve || this.pendingConfirms.size > 0 || this.controlPrompt) return false
    const li = this.lastItem
    if (li.kind === 'tool' || li.kind === 'thinking') return true
    if (li.kind !== 'assistant') return false
    const t = (li.text || '').trim()
    if (!t || /[?？]\s*$/.test(t)) return false
    const tail = t.split(/(?<=[.!?…])\s+/).pop() || ''
    return /[:：…]\s*$/.test(t) || /\b(let me|i'll|i will|i need to|now i|let's|попробую|давайте|сделаю|создам|напишу|запущу|сейчас (я )?(создам|напишу|попробую|запущу|сделаю|открою|нажму))\b/i.test(tail)
  }

  private async continueTurn() {
    this.nudges++
    const ru = this.lastLang === 'ru'
    this.emit('chat', { id: uid(), kind: 'system', text: ru ? '↻ Не закончил — продолжаю…' : '↻ Unfinished — continuing…', at: Date.now() } satisfies ChatItem)
    try {
      await this.opencode.send(
        '[auto-continue] You stopped before the job was finished. Do the next step NOW with a tool call (do not just describe it). If the task is complete, call jarvis_say with the real result; if it is impossible, say why with jarvis_say.',
        this.lastSystem,
        this.lastVia
      )
    } catch (e: any) {
      this.emit('chat', { id: uid(), kind: 'system', text: `⚠ ${e?.message || e}`, at: Date.now() } satisfies ChatItem)
      this.setControl(false)
      void this.onTurnEnd()
    }
  }

  private async onTurnEnd() {
    // Weaker models sometimes forget to talk — speak a short gist so voice requests never end in silence.
    if (this.lastWasVoice && !this.sayCalledThisTurn && this.lastAssistantText.trim()) {
      const gist = this.lastAssistantText
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[*_`#>\[\]()]/g, '')
        .trim()
      const first = splitSentences(gist)[0] ?? ''
      if (first && first.length <= 220) await this.say(first)
    }
    if (this.speakingDepth === 0) this.setState('idle')
  }

  // ---------------------------------------------------------------- speaking
  /**
   * Speech is queued: callers (the agent's jarvis_say tool) get control back immediately and keep working while Jarvis
   * talks; lines never overlap. stopSpeaking() drops everything still queued.
   */
  say(text: string, highlights: HighlightTarget[] = [], opts: { silent?: boolean } = {}): Promise<void> {
    if (!opts.silent) this.sayCalledThisTurn = true
    const epoch = this.sayEpoch
    const run = async () => {
      if (epoch !== this.sayEpoch) return
      await this.sayNow(text, highlights, opts)
    }
    const p = this.sayChain.then(run, run)
    this.sayChain = p.catch(() => {})
    return p
  }

  private async sayNow(text: string, highlights: HighlightTarget[] = [], opts: { silent?: boolean } = {}) {
    if (!opts.silent) this.sayCalledThisTurn = true
    const s = this.settings()
    const clean = speakable(text)
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return
    this.lastSpeechAt = Date.now()
    this.emit('chat', { id: uid(), kind: 'say', text: clean, at: Date.now() } satisfies ChatItem)
    this.emit('subtitle', clean)
    if (highlights.length) void this.overlay.show(highlights)

    const lang = detectLang(clean)
    let voice = lang === 'ru' ? s.voiceRu : s.voiceEn
    if (!this.tts.available(voice)) voice = lang === 'ru' ? 'ru_RU-denis-medium' : 'jarvis-high' // chosen voice not installed
    const ok = s.voiceEnabled && this.tts.available(voice)
    this.speakAbort = { aborted: false }
    const token = this.speakAbort
    this.speakingDepth++
    this.speech.speaking(true)
    this.setState('speaking')
    try {
      if (!ok) {
        await new Promise((r) => setTimeout(r, Math.min(6000, 700 + clean.length * 55)))
      } else {
        const sentences = splitSentences(clean)
        // a cloned voice that is still loading or failing must not leave Jarvis mute: fall back to Piper
        const synth = async (t: string) => {
          // cloned voice not loaded (it unloads when idle / is still starting): kick it off and answer with Piper now
          if (voice.startsWith('xtts:') && this.xtts.state !== 'ready') {
            void this.xtts.ensure().catch(() => {})
            const fb0 = lang === 'ru' ? 'ru_RU-denis-medium' : 'jarvis-high'
            if (this.tts.available(fb0)) return this.tts.synth(t, fb0, s.voiceSpeed, lang)
          }
          try {
            return await this.tts.synth(t, voice, s.voiceSpeed, lang)
          } catch (e) {
            if (!voice.startsWith('xtts:') && !voice.startsWith('fish:')) throw e
            console.warn('[tts] remote voice failed, falling back to Piper:', (e as Error).message)
            if (voice.startsWith('fish:') && !this.fishWarned) {
              this.fishWarned = true
              this.emit('chat', { id: uid(), kind: 'system', text: '⚠ ' + (e as Error).message + ' — using the local voice', at: Date.now() } satisfies ChatItem)
            }
            const fb = lang === 'ru' ? 'ru_RU-denis-medium' : 'jarvis-high'
            return this.tts.synth(t, fb, s.voiceSpeed, lang)
          }
        }
        let next = synth(sentences[0])
        for (let i = 0; i < sentences.length; i++) {
          const wav = await next
          if (token.aborted) break
          if (i + 1 < sentences.length) next = synth(sentences[i + 1])
          await Promise.race([
            this.play({ id: uid(), wav, fx: s.voiceFx && lang === 'en' ? true : s.voiceFx, volume: s.voiceVolume }),
            new Promise((r) => setTimeout(r, wavMillis(wav) + 5000)) // audio host never reported back
          ])
          if (token.aborted) break
        }
      }
    } catch (e) {
      console.error('[tts] failed', e)
    } finally {
      this.speakingDepth = Math.max(0, this.speakingDepth - 1)
      this.lastSpeechAt = Date.now()
      if (this.speakingDepth === 0) {
        this.speech.speaking(false)
        if (highlights.length) setTimeout(() => this.overlay.clear(), 500)
        this.emit('subtitle', '')
        if (this.state === 'speaking') this.setState(this.opencode.isBusy ? 'thinking' : 'idle')
      }
    }
  }

  private play(req: PlayRequest) {
    return new Promise<void>((resolve) => {
      this.playResolvers.set(req.id, resolve)
      this.emit('play', req)
    })
  }

  onPlayEnded(id: string) {
    const r = this.playResolvers.get(id)
    this.playResolvers.delete(id)
    r?.()
  }

  /** Stop button / abort IPC: cancel the agent turn and any in-flight computer actions. */
  async abortTask() {
    this.mcp.computer.cancel()
    await this.opencode.abort()
    this.stopSpeaking()
    this.setControl(false)
    this.setState('idle')
  }

  stopSpeaking() {
    this.sayEpoch++ // also cancels lines that are still queued
    this.speakAbort.aborted = true
    this.emit('stopPlayback')
    for (const [, r] of this.playResolvers) r()
    this.playResolvers.clear()
    this.overlay.clear()
  }

  highlight(targets: HighlightTarget[], ttlMs = 8000) {
    void this.overlay.show(targets, ttlMs)
  }
  clearHighlight() {
    this.overlay.clear()
  }

  // ---------------------------------------------------------------- ask / permissions
  /**
   * Ask the user something out loud. One question at a time (concurrent asks used to overwrite each other and hang).
   * The microphone opens IMMEDIATELY — an answer given while Jarvis is still reading the question is not lost — and the
   * answer can also be tapped / typed on the HUD or in the chat; whichever comes first closes the card everywhere.
   */
  ask(question: string, options?: string[], timeoutSec = 25): Promise<string> {
    const run = () => this.askNow(question, options, timeoutSec)
    const p = this.askQueue.then(run, run)
    this.askQueue = p.catch(() => '')
    return p
  }

  private async askNow(question: string, options: string[] | undefined, timeoutSec: number): Promise<string> {
    const ru = this.lastLang === 'ru'
    const id = 'ask-' + uid()
    this.askId = id
    this.askQuestion = question
    const req: PermissionRequest = {
      id,
      kind: 'question',
      title: question,
      options,
      hint: ru ? 'Можно ответить голосом — я слушаю' : "You can answer by voice — I'm listening"
    }
    this.emit('permission', req)
    let timer: NodeJS.Timeout | null = null
    const answered = new Promise<string>((resolve) => {
      this.askResolve = resolve
      timer = setTimeout(() => this.askId === id && this.resolveAsk(''), (timeoutSec + 12) * 1000)
    })
    this.commandListening = true
    this.speech.listenFor(timeoutSec + 12)
    this.setState('listening')
    void this.say(question, [], { silent: true }).catch(() => {})
    const a = await answered
    if (timer) clearTimeout(timer)
    this.askQuestion = ''
    if (this.speakingDepth > 0) this.stopSpeaking() // answered before the question was finished
    this.speech.cancelListen()
    this.emit('permissionClose', id)
    return a
  }

  /** True when a transcript is just the microphone picking up Jarvis reading the question aloud. */
  private isQuestionEcho(text: string): boolean {
    if (!this.askQuestion || this.speakingDepth === 0) return false
    const qt = new Set(normalize(this.askQuestion).split(' '))
    const tt = normalize(text).split(' ').filter(Boolean)
    if (!tt.length) return true
    const hits = tt.filter((w) => qt.has(w) || [...qt].some((q) => q.length > 3 && w.length > 3 && phraseScore(w, q) > 0.8)).length
    return hits / tt.length >= 0.6
  }

  private resolveAsk(a: string) {
    const r = this.askResolve
    this.askResolve = null
    this.askId = ''
    r?.(a)
  }

  /** Reply from the UI to either an agent permission/question or a jarvis_ask card. */
  async replyPermission(id: string, answer: 'once' | 'always' | 'reject' | string[] | string) {
    if (id.startsWith('ask-')) {
      this.speech.cancelListen()
      this.resolveAsk(Array.isArray(answer) ? answer.join(', ') : String(answer))
      return
    }
    const confirm = this.pendingConfirms.get(id)
    if (confirm) {
      this.pendingConfirms.delete(id)
      confirm(answer === 'once' || answer === 'always')
      return
    }
    await this.opencode.replyPermission(id, answer as any)
  }

  private onAgentPermission(r: PermissionRequest) {
    const mode = this.settings().permissionMode
    if (r.kind === 'permission' && mode === 'full-auto') {
      void this.opencode.replyPermission(r.id, 'once')
      return
    }
    this.emit('permission', r)
    if (this.lastWasVoice) void this.say(r.kind === 'question' ? r.title : `Permission needed: ${r.title}. Allow?`).catch(() => {})
  }

  /**
   * Computer use needs the user's OK — once per task. The question is spoken and shown as a card; the answer can be
   * voice ("да"/"нет") or a click. Full-autonomy mode skips the prompt but still shows the glow.
   */
  async confirmControl(_what: string): Promise<boolean> {
    const tid = this.threads.current?.id ?? 'none'
    if (this.settings().permissionMode === 'full-auto' || this.grantedThreads.has(tid)) {
      this.touchControl()
      return true
    }
    if (!this.controlPrompt) {
      this.controlPrompt = (async () => {
        const ru = this.lastLang === 'ru'
        const q = ru ? 'Мне нужно смотреть на экран и управлять мышью и клавиатурой. Разрешаете на этот чат?' : 'I need to see your screen and control the mouse and keyboard. Allow for this chat?'
        const opts = ru ? ['Разрешить для чата', 'Отклонить'] : ['Allow for this chat', 'Deny']
        const ans = await this.ask(q, opts, 20)
        const ok = /^(да|разреш|давай|ок|окей|конечно|валяй|можно|yes|yeah|allow|ok|okay|sure|go|do it|proceed)/i.test(ans.trim())
        if (ok) this.grantedThreads.add(tid)
        if (!ok) void this.say(ru ? 'Понял, управление отклонено.' : 'Understood, control declined.')
        return ok
      })()
    }
    const ok = await this.controlPrompt
    if (ok) this.touchControl()
    return ok
  }

  /** (Re)arm the glow: stays on while control tools keep being used, fades 7 s after the last one. */
  private touchControl() {
    this.setControl(true)
    if (this.controlTimer) clearTimeout(this.controlTimer)
    this.controlTimer = setTimeout(() => this.setControl(false), 7000)
  }

  private setControl(on: boolean) {
    if (this.controlTimer && !on) clearTimeout(this.controlTimer)
    if (this.controlOn === on) return
    this.controlOn = on
    const ru = this.lastLang === 'ru'
    void this.overlay.setControl(on, ru ? 'управляет компьютером · Ctrl+Alt+K — стоп' : 'is controlling your PC · Ctrl+Alt+K to stop')
    this.emitStatus()
  }

  /** Emergency stop (global hotkey): cancel the task, silence, drop permissions, kill the glow. */
  emergencyStop() {
    this.mcp.computer.cancel()
    this.grantedThreads.clear()
    this.controlPrompt = null
    void this.opencode.abort()
    this.stopSpeaking()
    this.setControl(false)
    this.setState('idle')
    this.emit('chat', { id: uid(), kind: 'system', text: '■ Stopped', at: Date.now() } satisfies ChatItem)
  }

  // ---------------------------------------------------------------- progress narration + watchdog
  private setActivity(a: string) {
    if (this.activity === a) return
    this.activity = a
    this.emitStatus()
  }

  private onTool(t: ToolEvent) {
    const name = t.tool.replace(/^jarvis_/, '')
    if (name === 'say' || name === 'ask') return
    // keep a short rolling list of what is being done, for the live step view
    {
      const label = this.toolLabel(name, t).replace(/…(\s·.*)?$/, '').replace(/\s·\sшаг\s\d+$|\s·\sstep\s\d+$/, '')
      const status = t.status === 'completed' ? 'done' : t.status === 'error' ? 'fail' : 'run'
      const i = this.liveSteps.findIndex((x) => x.id === t.id)
      const step = { id: t.id, label, status: status as 'run' | 'done' | 'fail', ms: t.ms }
      if (i >= 0) this.liveSteps[i] = step
      else this.liveSteps = [...this.liveSteps, step].slice(-6)
      this.emitStatus()
    }
    if (t.status === 'running' || t.status === 'pending') {
      if (t.status === 'running' && !this.seenTools.has(t.id)) this.stepCount++
      this.setActivity(this.toolLabel(name, t))
      if (t.status === 'running' && !this.seenTools.has(t.id)) {
        this.seenTools.add(t.id)
        // the model forgot to talk during a long task: say something short ourselves
        const quiet = Date.now() - this.lastSpeechAt
        if (this.lastWasVoice && this.speakingDepth === 0 && !this.askResolve && quiet > 16000 && this.opencode.isBusy) {
          void this.say(this.toolLabel(name, t, true))
        }
      }
    } else if (this.opencode.isBusy) {
      const ru = this.lastLang === 'ru'
      const n = this.stepCount
      this.setActivity(t.status === 'error' ? (ru ? 'Не вышло — пробую иначе…' : 'That failed — trying another way…') : ru ? `Разбираю результат${n ? ` · шаг ${n}` : ''}…` : `Reviewing the result${n ? ` · step ${n}` : ''}…`)
    }
  }

  /** Human-readable "what I'm doing right now" line built from the tool and its real arguments. */
  private toolLabel(name: string, t: ToolEvent, spoken = false): string {
    const ru = this.lastLang === 'ru'
    const i: any = t.input || {}
    const clip = (v: unknown, n = 40) => {
      const x = String(v ?? '').replace(/\s+/g, ' ').trim()
      return x.length > n ? x.slice(0, n - 1) + '…' : x
    }
    const host = (u: unknown) => {
      try {
        return new URL(String(u)).host.replace(/^www\./, '')
      } catch {
        return clip(u, 40)
      }
    }
    const app = i.app ? clip(i.app, 28) : ''
    const q = (ru: string, en: string, arg?: string) => [arg ? `${ru}: ${arg}` : ru, arg ? `${en}: ${arg}` : en] as [string, string]
    const map: Record<string, [string, string]> = {
      screen: ['Читаю экран', 'Reading the screen'],
      screenshot: ['Смотрю на экран', 'Looking at the screen'],
      ask_screen: q('Разглядываю экран', 'Studying the screen', clip(i.question, 40)),
      windows: ['Проверяю открытые окна', 'Checking open windows'],
      focus_window: q('Переключаюсь на окно', 'Switching to window', clip(i.title || i.name || i.app, 30)),
      list_apps: ['Смотрю запущенные приложения', 'Listing running apps'],
      get_app_state: app ? [`Изучаю окно «${app}»`, `Inspecting “${app}”`] : ['Изучаю окно приложения', 'Inspecting the app window'],
      click: i.element_index != null ? [`Нажимаю элемент №${i.element_index}${app ? ` в «${app}»` : ''}`, `Clicking element #${i.element_index}${app ? ` in “${app}”` : ''}`] : ['Нажимаю на экране', 'Clicking on screen'],
      click_text: q('Нажимаю', 'Clicking', i.text ? `«${clip(i.text, 30)}»` : ''),
      act: i.action === 'type' ? q('Ввожу текст', 'Typing', i.text ? `«${clip(i.text, 30)}»` : '') : ['Действую по карте экрана', 'Acting on the screen map'],
      set_value: q('Заполняю поле', 'Filling a field', i.value ? `«${clip(i.value, 30)}»` : ''),
      type_text: q('Печатаю', 'Typing', i.text ? `«${clip(i.text, 30)}»` : ''),
      press_key: q('Нажимаю клавишу', 'Pressing', clip(i.key, 24)),
      keys: q('Нажимаю', 'Pressing', clip(i.keys || i.key, 24)),
      scroll: ['Прокручиваю', 'Scrolling'],
      drag: ['Перетаскиваю', 'Dragging'],
      perform_secondary_action: q('Выполняю действие', 'Performing action', clip(i.action, 24)),
      wait: ['Жду, пока всё загрузится', 'Waiting for things to load'],
      wait_for: q('Жду появления', 'Waiting for', i.text ? `«${clip(i.text, 30)}»` : i.window ? `«${clip(i.window, 30)}»` : ''),
      open_app: q('Запускаю', 'Launching', clip(i.name || i.app, 30)),
      open_url: q('Открываю сайт', 'Opening', host(i.url)),
      highlight: ['Показываю на экране', 'Pointing it out'],
      clipboard_get: ['Читаю буфер обмена', 'Reading the clipboard'],
      clipboard_set: ['Копирую в буфер обмена', 'Copying to the clipboard'],
      bash: [spoken ? 'Выполняю команду' : `Команда: ${clip(i.command, 50)}`, spoken ? 'Running a command' : `Command: ${clip(i.command, 50)}`],
      webfetch: q('Читаю страницу', 'Reading', host(i.url)),
      websearch: q('Ищу в интернете', 'Searching the web', clip(i.query, 40)),
      read: q('Читаю файл', 'Reading', clip(String(i.filePath || i.path || '').split(/[\\/]/).pop(), 30)),
      write: q('Записываю файл', 'Writing', clip(String(i.filePath || i.path || '').split(/[\\/]/).pop(), 30)),
      edit: q('Правлю файл', 'Editing', clip(String(i.filePath || i.path || '').split(/[\\/]/).pop(), 30)),
      glob: ['Ищу файлы', 'Searching for files'],
      grep: q('Ищу в файлах', 'Searching files', clip(i.pattern, 30)),
      paste: ['Вставляю текст', 'Pasting text'],
      window_control: q(i.action === 'close' ? 'Закрываю окно' : i.action === 'minimize' ? 'Сворачиваю окно' : i.action === 'maximize' ? 'Разворачиваю окно' : 'Расставляю окно', i.action === 'close' ? 'Closing the window' : i.action === 'minimize' ? 'Minimising the window' : i.action === 'maximize' ? 'Maximising the window' : 'Arranging the window', app),
      volume: q('Громкость', 'Volume', i.level != null ? String(i.level) + '%' : String(i.action || '')),
      media: ['Управляю плеером', 'Controlling playback'],
      desktop: ['Рабочий стол', 'Desktop'],
      sequence: ['Выполняю последовательность действий', 'Running an input sequence'],
      mouse: ['Управляю мышью', 'Using the mouse'],
      hold_key: q('Удерживаю клавишу', 'Holding a key', clip(i.keys, 12)),
      scroll_at: ['Прокручиваю', 'Scrolling'],
      type: q('Печатаю', 'Typing', i.text ? `«${clip(i.text, 30)}»` : ''),
      remember: ['Запоминаю', 'Remembering'],
      recall: ['Вспоминаю', 'Recalling'],
      forget: ['Забываю', 'Forgetting'],
      routine_save: q('Сохраняю команду', 'Saving command', clip(i.name, 30)),
      routine_run: q('Выполняю команду', 'Running command', clip(i.name, 30))
    }
    const m = map[name]
    const step = this.stepCount > 1 && !spoken ? (ru ? ` · шаг ${this.stepCount}` : ` · step ${this.stepCount}`) : ''
    if (!m) return (ru ? `Выполняю: ${name.replace(/_/g, ' ')}` : `Running: ${name.replace(/_/g, ' ')}`) + (spoken ? '' : '…') + step
    return (ru ? m[0] : m[1]) + (spoken ? (ru ? ', сэр.' : ', sir.') : '…') + step
  }

  /** Abort turns that went silent for too long (hung tool, lost event stream) instead of staying on "working" forever. */
  private checkWatchdog() {
    const waiting = this.askResolve || this.pendingConfirms.size > 0 || this.controlPrompt
    if (!this.opencode?.isBusy || waiting || this.speakingDepth > 0) return
    if (Date.now() - this.opencode.lastEventAt > 150_000) {
      this.mcp.computer.cancel()
      void this.opencode.abort()
      this.setControl(false)
      this.emit('chat', { id: uid(), kind: 'system', text: this.lastLang === 'ru' ? '⚠ Задача зависла — остановил' : '⚠ Task stalled — stopped', at: Date.now() } satisfies ChatItem)
      this.setState('idle')
    }
  }

  // ---------------------------------------------------------------- routines
  async runRoutine(r: Routine): Promise<string> {
    const log: string[] = []
    for (const step of r.steps) {
      try {
        log.push(await this.runStep(step))
      } catch (e: any) {
        log.push(`step ${step.type} failed: ${e?.message || e}`)
      }
    }
    return log.join('\n')
  }

  private async runStep(step: RoutineStep): Promise<string> {
    const r = await this.runStepInner(step)
    if (step.after) await new Promise((res) => setTimeout(res, Math.min(step.after!, 60000)))
    return r
  }

  private async runStepInner(step: RoutineStep): Promise<string> {
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
    switch (step.type) {
      case 'focus':
        await this.win.call('focus', { title: step.target })
        return 'focused ' + step.target
      case 'click': {
        let x = step.x ?? 0
        let y = step.y ?? 0
        if (step.text) {
          const c = this.mcp.computer
          let hit = c.find(step.text, await c.scan({}), true).filter((m) => m.score >= 0.7)[0]
          if (!hit) {
            await sleep(600)
            hit = c.find(step.text, await c.scan({}), true).filter((m) => m.score >= 0.7)[0]
          }
          if (!hit) throw new Error(`"${step.text}" is not on screen`)
          x = Math.round(hit.rect.x + hit.rect.w / 2)
          y = Math.round(hit.rect.y + hit.rect.h / 2)
        }
        await this.win.call('click', { x, y, button: step.button ?? 'left', count: step.count ?? 1 })
        return `clicked ${x},${y}`
      }
      case 'move':
        await this.win.call('move', { x: step.x, y: step.y })
        return 'moved'
      case 'scroll': {
        const n = Math.max(1, Math.min(60, step.amount))
        await this.win.call('scroll', { ...(step.x !== undefined ? { x: step.x, y: step.y } : {}), dy: step.direction === 'down' ? n : step.direction === 'up' ? -n : 0, dx: step.direction === 'right' ? n : step.direction === 'left' ? -n : 0 })
        return 'scrolled'
      }
      case 'hold': {
        await this.win.call('keydown', { keys: step.keys, scan: !!step.scan })
        try {
          const t0 = Date.now()
          await sleep(Math.min(400, step.ms))
          // auto-repeat like a held physical key
          while (Date.now() - t0 < Math.min(step.ms, 20000)) {
            await this.win.call('keydown', { keys: step.keys, scan: !!step.scan })
            await sleep(35)
          }
        } finally {
          await this.win.call('keyup', { keys: step.keys, scan: !!step.scan }).catch(() => {})
        }
        return 'held ' + step.keys
      }
      case 'say':
        await this.say(step.text)
        return 'said'
      case 'open':
        await this.powershell(`Start-Process ${psQuote(step.target)}`)
        return 'opened ' + step.target
      case 'run':
        return (await this.powershell(step.command)).slice(0, 400) || 'ran'
      case 'keys':
        await this.win.call('keys', { keys: step.keys, scan: !!step.scan })
        return 'keys'
      case 'type':
        await this.win.call('type', { text: step.text, char_delay: step.charDelay ?? 4 })
        return 'typed'
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(step.ms, 60000)))
        return 'waited'
      case 'agent':
        await this.runAgentTask(step.prompt)
        return 'agent task done'
    }
  }

  private runAgentTask(prompt: string) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.opencode.off('turnEnd', done)
        resolve()
      }
      this.opencode.on('turnEnd', done)
      void this.handleCommand(prompt, 'text').catch(done)
    })
  }

  powershell(cmd: string, timeout = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (out += d))
      const t = setTimeout(() => {
        p.kill()
        reject(new Error('timeout'))
      }, timeout)
      p.on('close', () => {
        clearTimeout(t)
        resolve(out.trim())
      })
      p.on('error', reject)
    })
  }

  // ---------------------------------------------------------------- manual controls
  toggleListen() {
    if (this.state === 'listening') {
      this.speech.cancelListen()
      this.setState('idle')
      return
    }
    if (this.speakingDepth > 0) this.stopSpeaking()
    this.emit('wake')
    this.speech.listenFor(this.settings().followupSeconds)
    this.setState('listening')
    void this.ack()
  }

  async dispose() {
    this.speech.dispose()
    this.tts.dispose()
    this.xtts.stop()
    this.win.dispose()
    this.scanWin.dispose()
    this.overlay.dispose()
    this.mcp.stop()
    await this.opencode?.stop()
  }
}

function psQuote(s: string) {
  return `'${s.replace(/'/g, "''")}'`
}

function wavMillis(wav: Buffer): number {
  // mp3 from the free voice server (64 kbit/s)
  if (wav.toString('ascii', 0, 3) === 'ID3' || (wav[0] === 0xff && (wav[1] & 0xe0) === 0xe0)) return Math.round((wav.length / 8000) * 1000)
  try {
    const rate = wav.readUInt32LE(24)
    const bytes = wav.readUInt32LE(40) || wav.length - 44
    return Math.round((bytes / 2 / rate) * 1000)
  } catch {
    return 8000
  }
}
