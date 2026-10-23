import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray, desktopCapturer, net } from 'electron'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { IPC, DEFAULT_SETTINGS, type Settings, type SetupProgress } from '../shared/types'
import { Assistant } from './assistant'
import { dataDir } from './store'
import { listAssets, installAsset } from './models'
import { rendererUrl, preloadPath, resourcePath } from './paths'
import { initLogging, logDir } from './log'
import { Updater } from './updater'

// promo capture / tests: run with a throw-away profile so the real data is never touched
if (process.env.JARVIS_USERDATA) app.setPath('userData', process.env.JARVIS_USERDATA)
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setName('Jarvis')
initLogging()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('js-flags', '--expose-gc') // lets the speech worker hand model memory back when idle
// memory: network and audio services run inside the main process instead of two extra processes.
// (No process-per-site: sharing one renderer between the opaque main window and the transparent HUD / overlay makes
// those windows paint an opaque background on Windows — the whole screen went dark during computer use.)
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess')
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion')

let assistant: Assistant
let mainWin: BrowserWindow | null = null
let hudWin: BrowserWindow | null = null
let tray: Tray | null = null
const updater = new Updater({
  lang: () => {
    const l = assistant?.settings().interfaceLang
    return l === 'ru' || l === 'en' ? l : app.getLocale().startsWith('ru') ? 'ru' : 'en'
  },
  parent: () => (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() ? mainWin : undefined)
})
let quitting = false

const all = () => [mainWin, hudWin].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
const broadcast = (ch: string, ...args: unknown[]) => all().forEach((w) => w.webContents.send(ch, ...args))
const toUi = (ch: string, ...args: unknown[]) => [mainWin, hudWin].forEach((w) => w && !w.isDestroyed() && w.webContents.send(ch, ...args))

function iconImage() {
  const p = resourcePath('icon.png')
  return existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
}

function createMain() {
  const s = assistant.settings()
  const promo = !!process.env.JARVIS_PROMO // off-screen rendering for the promo video (src/main/promo.ts)
  mainWin = new BrowserWindow({
    width: promo ? 1080 : 1180,
    height: promo ? 1920 : 760,
    useContentSize: promo,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#05080d',
    title: 'Jarvis',
    icon: iconImage(),
    webPreferences: { preload: preloadPath(), backgroundThrottling: false, offscreen: promo }
  })
  mainWin.on('ready-to-show', () => {
    if (!s.startMinimized) mainWin?.show()
  })
  // closing to the tray DESTROYS the window (≈200 MB of renderer memory); showMain() rebuilds it from main-process state
  mainWin.on('closed', () => {
    mainWin = null
    syncHud()
  })
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // the HUD would sit on top of the main window, so it only shows while the main window is not in use
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'move', 'resize', 'maximize', 'unmaximize'] as const) mainWin.on(ev as any, syncHud)
  void mainWin.loadURL(rendererUrl('index.html'))
}

/** Windows drops TOPMOST on a window when its style flags change (focusable / click-through) or when another topmost window
 *  (video players, games, taskbar thumbnails) is raised: re-assert it at the highest level every time the HUD is touched. */
function raiseHud() {
  if (!hudWin || hudWin.isDestroyed() || !hudWin.isVisible()) return
  hudWin.setAlwaysOnTop(true, 'screen-saver')
  hudWin.moveTop()
}

let hudSig = ''
function syncHud() {
  if (!hudWin || hudWin.isDestroyed()) return
  // permission cards must always be reachable: grow the HUD, make it clickable, and keep it visible
  if (pendingPerms.size > 0) {
    const sig = 'perm' + pendingPerms.size + assistant.settings().hudCorner
    if (sig !== hudSig) {
      hudSig = sig
      hudWin.setBounds(hudBounds(assistant.settings().hudCorner, 200 * pendingPerms.size))
      hudWin.setIgnoreMouseEvents(false)
      hudWin.setFocusable(true)
    }
    if (!hudWin.isVisible()) hudWin.showInactive()
    raiseHud()
    return
  }
  // normal mode: only touch the window when something changed (every style change risks losing TOPMOST)
  const sig = 'idle' + assistant.settings().hudCorner
  if (sig !== hudSig) {
    hudSig = sig
    hudWin.setBounds(hudBounds(assistant.settings().hudCorner))
    hudWin.setFocusable(false)
    hudWin.setIgnoreMouseEvents(true, { forward: true })
  }
  // the HUD would sit on top of the main window while the user is looking at it: hide it only then — i.e. when the main
  // window is the focused one and the two rectangles intersect (a main window hidden behind other apps must not hide the HUD)
  let overlaps = false
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused()) {
    const a = mainWin.getBounds()
    const b = hudWin.getBounds()
    overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }
  if (process.env.JARVIS_DEBUG_HUD) console.log('[hud]', JSON.stringify({ overlaps, visible: hudWin.isVisible(), mainFocused: !!mainWin && !mainWin.isDestroyed() && mainWin.isFocused(), mainVisible: !!mainWin && !mainWin.isDestroyed() && mainWin.isVisible(), bounds: hudWin.getBounds(), onTop: hudWin.isAlwaysOnTop() }))
  if (overlaps) {
    if (hudWin.isVisible()) hudWin.hide()
  } else {
    if (!hudWin.isVisible()) hudWin.showInactive()
    raiseHud()
  }
}

const pendingPerms = new Set<string>()

function hudBounds(corner: Settings['hudCorner'], extra = 0) {
  const wa = screen.getPrimaryDisplay().workArea
  const w = 520 // orb glow (~300 px) + the letter-spaced state label must fit, or the label is clipped
  const h = Math.min(wa.height - 40, 260 + extra)
  const m = 14
  const x = corner.endsWith('r') ? wa.x + wa.width - w - m : wa.x + m
  const y = corner.startsWith('b') ? wa.y + wa.height - h - m : wa.y + m
  return { x, y, width: w, height: h }
}

function createHud() {
  hudWin = new BrowserWindow({
    ...hudBounds(assistant.settings().hudCorner),
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: preloadPath(), backgroundThrottling: false }
  })
  hudWin.setAlwaysOnTop(true, 'screen-saver')
  hudWin.setIgnoreMouseEvents(true, { forward: true })
  hudWin.once('ready-to-show', syncHud)
  // keep it visible and on top: re-assert periodically (fullscreen apps and other topmost windows push it down), and follow
  // monitor changes (unplugged display, resolution / scaling change would leave it off-screen)
  setInterval(() => {
    if (!hudWin || hudWin.isDestroyed()) return
    if (!hudWin.isVisible() || hudWin.isMinimized()) return syncHud()
    raiseHud()
  }, 2000)
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const)
    screen.on(ev as any, () => {
      hudSig = ''
      syncHud()
    })
  hudWin.on('hide', () => setTimeout(syncHud, 400)) // never stay hidden while nothing justifies it
  void hudWin.loadURL(rendererUrl('hud.html') + (process.env.JARVIS_PROMO ? '?noaudio=1' : '')) // promo capture must never listen to the room
}


function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMain()
  mainWin!.show()
  mainWin!.focus()
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  globalShortcut.register('Control+Alt+K', () => assistant.emergencyStop())
  const key = assistant.settings().hotkey
  if (!key) return
  try {
    if (!globalShortcut.register(key, () => assistant.toggleListen())) console.warn('hotkey busy', key)
  } catch (e) {
    console.warn('bad hotkey', key, e)
  }
}

function applyAutoStart() {
  app.setLoginItemSettings({ openAtLogin: assistant.settings().autoStart, args: ['--hidden'] })
}

function buildTray() {
  tray = new Tray(iconImage().resize({ width: 16, height: 16 }))
  tray.setToolTip('Jarvis')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open Jarvis', click: showMain },
      { label: 'Listen now', click: () => assistant.toggleListen() },
      {
        label: 'Wake word active',
        type: 'checkbox',
        checked: assistant.settings().wakeEnabled,
        click: (m) => applySettings({ wakeEnabled: m.checked })
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  tray.setContextMenu(menu())
  tray.on('click', showMain)
  assistant.settingsStore.on('change', () => tray?.setContextMenu(menu()))
}

function applySettings(patch: Partial<Settings>) {
  const before = assistant.settings()
  const next = assistant.settingsStore.set(patch)
  broadcast(IPC.settingsChanged, next)
  if (patch.sttModel && patch.sttModel !== before.sttModel) assistant.speech.restart()
  else if ('wakePhrases' in patch || 'wakeSensitivity' in patch || 'wakeEnabled' in patch || 'sttLanguage' in patch) assistant.speech.updateConfig()
  if (patch.apiKey !== undefined && patch.apiKey !== before.apiKey) void assistant.opencode.applyAuth().then(() => assistant.opencode.listModels(true))
  if ((patch.permissionMode && patch.permissionMode !== before.permissionMode) || (patch.cwd !== undefined && patch.cwd !== before.cwd) || (patch.customProvider && JSON.stringify(patch.customProvider) !== JSON.stringify(before.customProvider)) || (patch.connectors && JSON.stringify(patch.connectors) !== JSON.stringify(before.connectors)))
    void assistant.opencode.restart()
  if (patch.autoUpdate) updater.setMode(patch.autoUpdate)
  if (patch.hotkey !== undefined) registerHotkey()
  if (patch.autoStart !== undefined) applyAutoStart()
  if (patch.hudCorner) {
    hudSig = ''
    syncHud()
  }
  if (patch.cloneIdleMinutes !== undefined) assistant.xtts.idleMinutes = patch.cloneIdleMinutes
  if ('fishApiKey' in patch || 'fishVoiceRu' in patch || 'fishVoiceEn' in patch || 'fishModel' in patch) {
    assistant.resetFishState()
    assistant.prewarmVoices()
  }
  if (patch.voiceRu || patch.voiceEn) assistant.prewarmVoices()
  assistant.emitStatus()
  return next
}

function wireIpc() {
  ipcMain.handle(IPC.settingsGet, () => assistant.settings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => applySettings(patch))
  ipcMain.handle('status:get', () => assistant.status())
  ipcMain.handle(IPC.chatHistory, () => assistant.opencode.history())
  ipcMain.handle(IPC.sendText, (_e, text: string) => assistant.handleCommand(text, 'text'))
  ipcMain.handle(IPC.abort, () => assistant.abortTask())
  ipcMain.handle(IPC.chatReset, () => assistant.opencode.newThread())
  ipcMain.handle(IPC.threads, () => assistant.threads.state())
  ipcMain.handle(IPC.threadNew, () => assistant.opencode.newThread())
  ipcMain.handle(IPC.threadSwitch, (_e, id: string) => assistant.opencode.switchThread(id))
  ipcMain.handle(IPC.threadDelete, (_e, id: string) => assistant.opencode.deleteThread(id))
  ipcMain.handle(IPC.threadRename, (_e, id: string, title: string) => assistant.threads.rename(id, title))
  ipcMain.handle(IPC.models, (_e, fetchAll: boolean) => assistant.opencode.listModels(fetchAll))
  ipcMain.handle(IPC.permissionReply, (_e, id: string, answer: any) => {
    pendingPerms.delete(id)
    toUi(IPC.permissionClose, id) // answered here → close the mirrored card in the other window too
    syncHud()
    return assistant.replyPermission(id, answer)
  })
  ipcMain.handle(IPC.toggleListen, () => assistant.toggleListen())

  ipcMain.handle(IPC.modelAssets, () => listAssets(dataDir()))
  ipcMain.handle(IPC.modelDownload, (_e, ids: string[]) => installAssets(ids))

  ipcMain.handle(IPC.routines, () => assistant.routines.list())
  ipcMain.handle(IPC.routinesSave, (_e, r) => assistant.routines.save1(r))
  ipcMain.handle(IPC.routinesDelete, (_e, id: string) => assistant.routines.delete(id))
  ipcMain.handle(IPC.routinesRun, (_e, id: string) => {
    const r = assistant.routines.get(id)
    return r ? assistant.runRoutine(r) : 'not found'
  })
  ipcMain.handle(IPC.memory, () => assistant.memory.list())
  ipcMain.handle(IPC.memoryAdd, (_e, text: string) => assistant.memory.add(text, [], false))
  ipcMain.handle(IPC.memoryDelete, (_e, id: string) => assistant.memory.delete(id))
  ipcMain.handle(IPC.memoryPin, (_e, id: string, pinned: boolean) => assistant.memory.pin(id, pinned))

  ipcMain.handle(IPC.openPath, (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:dataDir', () => dataDir())
  ipcMain.handle('app:openLogs', () => shell.openPath(logDir()))
  // only ever opens plain https links (key pages) in the user's browser
  ipcMain.handle('app:openUrl', (_e, url: string) => (/^https:\/\//.test(String(url)) ? shell.openExternal(url) : undefined))
  ipcMain.handle('update:state', () => updater.state)
  ipcMain.handle('update:check', () => updater.check(false))
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', () => updater.install())
  ipcMain.handle('agent:wake', () => assistant.opencode.wake())
  ipcMain.handle('connectors:status', () => assistant.opencode.mcpStatus())
  ipcMain.handle('connectors:auth', (_e, id: string) => assistant.opencode.mcpAuthenticate(String(id)))
  ipcMain.handle('connectors:reconnect', async (_e, id: string) => {
    await assistant.opencode.mcpReconnect(String(id))
    return assistant.opencode.mcpStatus()
  })
  ipcMain.handle('connectors:signout', async (_e, id: string) => {
    await assistant.opencode.mcpSignOut(String(id))
    return assistant.opencode.mcpStatus()
  })
  ipcMain.handle('voice:serverHealth', async () => {
    try {
      const base = (assistant.settings().ttsServerUrl || DEFAULT_SETTINGS.ttsServerUrl).replace(/\/+$/, '')
      const r = await net.fetch(base + '/api/health', { signal: AbortSignal.timeout(8000) })
      return await r.json()
    } catch (e: any) {
      return { ok: false, notice: '' }
    }
  })
  ipcMain.handle('providers:list', async () => {
    await assistant.opencode.wake()
    return assistant.opencode.providers()
  })
  ipcMain.handle('providers:connect', async (_e, id: string, key: string) => {
    await assistant.opencode.connectProvider(id, key)
    return true
  })
  ipcMain.handle('providers:disconnect', async (_e, id: string) => {
    await assistant.opencode.disconnectProvider(id)
    return true
  })
  ipcMain.handle('app:info', () => {
    const st = assistant.status()
    const mem = process.memoryUsage()
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform} ${process.arch}`,
      dataDir: dataDir(),
      logDir: logDir(),
      status: st,
      model: assistant.settings().model,
      assets: listAssets(dataDir()).filter((a) => a.installed).map((a) => a.id),
      cloneAvailable: assistant.xtts.available(),
      asrLoaded: assistant.speech.asrLoaded,
      mainRssMB: Math.round(mem.rss / 1048576)
    }
  })
  ipcMain.handle(IPC.captureForUi, async () => {
    const img = await mainWin?.webContents.capturePage()
    return img?.toPNG()
  })
  ipcMain.handle('voice:extra', () => {
    const s = assistant.settings()
    const out: { id: string; name: string; lang: 'ru' | 'en' | 'both' }[] = []
    if (s.fishApiKey) out.push({ id: 'fish:ru', name: 'Fish Audio — Jarvis (RU, cloud)', lang: 'ru' })
    if (s.fishApiKey) out.push({ id: 'fish:en', name: 'Fish Audio — Jarvis (EN, cloud)', lang: 'en' })
    if (assistant.xtts.available()) out.push({ id: 'xtts:jarvis', name: 'Jarvis — cloned from your clips (local GPU, RU + EN)', lang: 'both' })
    return out
  })
  ipcMain.handle('voice:preview', async (_e, text: string, voice: string) => {
    const lang = /[а-яё]/i.test(text) ? 'ru' : 'en'
    const wav = await assistant.tts.synth(text, voice, assistant.settings().voiceSpeed, lang)
    toUi('noop')
    hudWin?.webContents.send(IPC.ttsPlay, { id: 'preview-' + Date.now(), wav, fx: assistant.settings().voiceFx, volume: assistant.settings().voiceVolume })
  })
  ipcMain.handle('ocr:langs', async () => {
    try {
      return await assistant.powershell(
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime; [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]; ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ','"
      )
    } catch {
      return ''
    }
  })

  ipcMain.on(IPC.window, (e, action: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize())
    else if (action === 'close') w.close()
    else if (action === 'showMain') showMain()
    else if (action === 'hud-interactive') hudWin?.setIgnoreMouseEvents(false)
    else if (action === 'hud-passthrough') hudWin?.setIgnoreMouseEvents(true, { forward: true })
  })

  // audio host → speech engine
  ipcMain.on(IPC.audioChunk, (_e, buf: ArrayBuffer) => assistant.speech.feed(buf))
  ipcMain.on(IPC.micLevel, (_e, level: number) => toUi(IPC.micLevel, level))
  ipcMain.on(IPC.ttsLevel, (_e, level: number) => toUi(IPC.ttsLevel, level))
  ipcMain.on(IPC.ttsEnded, (_e, id: string) => assistant.onPlayEnded(id))
}

// ---- dependency installer: one queue, so the launch-time auto install and the Setup button never race ----
let installChain: Promise<unknown> = Promise.resolve()
function installAssets(ids: string[], tries = 1) {
  const run = async () => {
    for (const id of ids) {
      if (listAssets(dataDir()).find((a) => a.id === id)?.installed) continue
      for (let n = 1; n <= tries; n++) {
        try {
          await installAsset(dataDir(), id, (p: SetupProgress) => toUi(IPC.modelProgress, p))
          break
        } catch (e) {
          console.error(`download failed (${n}/${tries})`, id, e)
          if (n < tries) await new Promise((r) => setTimeout(r, 3000 * n))
        }
      }
    }
    assistant.prewarmVoices()
    if (!assistant.speech.ready && !assistant.speech.missing().length) assistant.speech.start()
    assistant.emitStatus()
    const list = listAssets(dataDir())
    broadcast('assets:changed', list)
    return list
  }
  const p = installChain.then(run, run)
  installChain = p.catch(() => {})
  return p
}

/** Downloads every required model the app is missing, without waiting for the user; retries later while offline. */
async function autoInstall() {
  const missing = () => listAssets(dataDir()).filter((a) => a.required && !a.installed).map((a) => a.id)
  if (!missing().length) return
  console.log('[setup] auto-installing', missing().join(', '))
  await installAssets(missing(), 3)
  if (missing().length) setTimeout(() => void autoInstall(), 5 * 60_000)
}

function wireAssistantEvents() {
  assistant.on('status', (s) => broadcast(IPC.status, s))
  assistant.on('chat', (item) => toUi(IPC.chat, item))
  assistant.on('permission', (r) => {
    pendingPerms.add(r.id)
    toUi(IPC.permission, r)
    syncHud()
  })
  assistant.routines.on('change', () => toUi(IPC.routinesChanged))
  assistant.threads.on('change', () => toUi(IPC.threadsChanged, assistant.threads.state()))
  assistant.on('chatReset', () => toUi(IPC.chatReset))
  assistant.memory.on('change', () => toUi(IPC.memoryChanged))
  assistant.on('permissionClose', (id) => {
    pendingPerms.delete(id)
    toUi(IPC.permissionClose, id)
    syncHud()
  })
  assistant.on('subtitle', (t: string) => toUi(IPC.subtitle, t))
  assistant.on('partial', (t: string) => toUi(IPC.transcript, t))
  // the HUD window also hosts the microphone and speech playback (one renderer process less)
  assistant.on('play', (req) => hudWin?.webContents.send(IPC.ttsPlay, req))
  assistant.on('stopPlayback', () => hudWin?.webContents.send(IPC.ttsStop))
  assistant.on('wake', () => hudWin?.webContents.send('audio:earcon', 'wake'))
  assistant.on('earcon', (kind: string) => hudWin?.webContents.send('audio:earcon', kind))
}

async function debugPrompts(list: string[]) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  while (assistant.opencode.status !== 'ready') await wait(500)
  if (process.env.JARVIS_AUTOYES) assistant.on('permission', (r: any) => setTimeout(() => void assistant.replyPermission(r.id, r.options?.[0] ?? 'once'), 1800))
  assistant.on('chat', (it: any) => {
    if (it.kind === 'assistant' && !it.done) return
    const body = it.kind === 'tool' ? `${it.tool.tool} [${it.tool.status}] ${JSON.stringify(it.tool.input ?? {}).slice(0, 160)} -> ${(it.tool.output ?? '').slice(0, 700).split('\n').join(' | ')}` : it.text
    console.log(`[e2e] ${it.kind}: ${body}`)
  })
  if (process.env.JARVIS_ABORT_AFTER) setTimeout(() => { console.log('[e2e] *** ABORT'); void assistant.abortTask() }, Number(process.env.JARVIS_ABORT_AFTER))
  for (const p of list) {
    console.log('[e2e] >>> ' + p)
    if (p.startsWith('!')) {
      await assistant.handleCommand(p.slice(1), 'voice')
      await wait(3500)
      continue
    }
    await assistant.handleCommand(p, 'voice')
    await new Promise<void>((r) => assistant.opencode.once('turnEnd', () => setTimeout(r, 1500)))
  }
  await mainWin?.webContents.executeJavaScript("window.__setPage && window.__setPage('assistant')")
  await new Promise((r) => setTimeout(r, 800))
  await new Promise((r) => setTimeout(r, 700))
  if (process.env.JARVIS_SHOTS) writeFileSync(join(process.env.JARVIS_SHOTS, 'chat.png'), (await mainWin!.webContents.capturePage()).toPNG())
  if (process.env.JARVIS_SHOTS) {
    mainWin?.show()
    mainWin?.setAlwaysOnTop(true, 'screen-saver') // a fullscreen video must not hide the window we are capturing
    mainWin?.moveTop()
    await new Promise((r) => setTimeout(r, 1200))
    await assistant.win.call('screenshot', { path: join(process.env.JARVIS_SHOTS, 'chat-desktop.png') })
    await mainWin?.webContents.executeJavaScript("document.querySelectorAll('.thread-bar .btn')[0]?.click(); document.querySelector('.think > button')?.click()")
    await new Promise((r) => setTimeout(r, 900))
    await assistant.win.call('screenshot', { path: join(process.env.JARVIS_SHOTS, 'process-desktop.png') })
    mainWin?.setAlwaysOnTop(false)
  }
  console.log('[e2e] finished')
}

async function debugShots(dir: string) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  await wait(7000)
  const shot = async (w: BrowserWindow | null, name: string) => {
    if (!w || w.isDestroyed()) return
    const img = await w.webContents.capturePage()
    writeFileSync(join(dir, name + '.png'), img.toPNG())
  }
  for (const p of ['assistant', 'routines', 'memory', 'settings']) {
    await mainWin?.webContents.executeJavaScript(`window.__setPage && window.__setPage('${p}')`)
    await wait(900)
    await shot(mainWin, 'main-' + p)
    if (p === 'settings') {
      for (let i = 0; i < 7; i++) {
        await mainWin?.webContents.executeJavaScript(`document.querySelectorAll('.subnav-item')[${i}]?.click()`)
        await wait(700)
        await shot(mainWin, 'main-settings-' + i)
      }
    }
  }
  await shot(hudWin, 'hud')
  if (process.env.JARVIS_OVERLAY) {
    mainWin?.show()
    const b = mainWin!.getBounds()
    const sf = screen.getPrimaryDisplay().scaleFactor
    await mainWin?.webContents.executeJavaScript("window.__setPage('assistant')")
    assistant.emit('permission', { id: 'ask-demo', kind: 'question', title: 'Мне нужно смотреть на экран и управлять мышью и клавиатурой. Разрешаете на этот чат?', options: ['Разрешить для чата', 'Отклонить'] })
    await wait(1200)
    await shot(hudWin, 'hud-permission')
    await shot(mainWin, 'chat-permission')
    await assistant.win.call('screenshot', { path: join(dir, 'desktop-permission.png') })
    assistant.emit('permissionClose', 'ask-demo')
    await wait(500)
    await assistant.overlay.setControl(true, 'управляет компьютером · Ctrl+Alt+K — стоп')
    await assistant.overlay.show([
      { x: (b.x + 100) * sf, y: (b.y + 60) * sf, w: 360 * sf, h: 60 * sf, label: 'Orb — current state', shape: 'box' },
      { x: (b.x + 700) * sf, y: (b.y + 500) * sf, w: 200 * sf, h: 40 * sf, label: 'Try this', shape: 'underline' }
    ])
    await wait(1600)
    await assistant.win.call('screenshot', { path: join(dir, 'overlay.png') })
    assistant.overlay.clear()
    await assistant.overlay.setControl(false)
  }
  console.log('[shots] done')
}

app.on('second-instance', showMain)
app.on('before-quit', () => {
  quitting = true
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'audioCapture', 'clipboard-sanitized-write'].includes(permission)))
  session.defaultSession.setPermissionCheckHandler(() => true)
  assistant = new Assistant()
  wireIpc()
  wireAssistantEvents()
  createMain()
  createHud()
  buildTray()
  registerHotkey()
  applyAutoStart()
  await assistant.init()
  void autoInstall()
  updater.init(assistant.settings().autoUpdate)
  updater.on('state', (st) => broadcast('update:changed', st))
  if (process.env.JARVIS_TEST_WAIT) {
    await new Promise((r) => setTimeout(r, 4000))
    const c = assistant.mcp.computer
    const t0 = Date.now()
    const r = await c.waitStable({ timeoutSec: 12, epoch: c.begin() })
    console.log(`[wait-test] stable=${r.stable} waited=${r.waitedMs}ms total=${Date.now() - t0}ms title="${r.title}"`)
  }
  if (process.env.JARVIS_FEED) {
    // feed 16 kHz mono wav files through the real engine (worker + ASR child) and log what comes out
    const { readFileSync } = await import('fs')
    assistant.speech.on('event', (e: any) => {
      if (e.type !== 'partial') console.log('[feed]', JSON.stringify(e).slice(0, 260))
    })
    await new Promise((r) => setTimeout(r, 4000))
    for (const f of (process.env.JARVIS_FEED as string).split(';')) {
      const b = readFileSync(f)
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)))
      const all = new Float32Array(16000 * 2 + pcm.length)
      for (let i = 0; i < pcm.length; i++) all[16000 + i] = pcm[i] / 32768
      console.log('[feed] >>>', f)
      for (let o = 0; o < all.length; o += 1600) {
        assistant.speech.feed(all.slice(o, o + 1600).buffer)
        await new Promise((r) => setTimeout(r, 8))
      }
      await new Promise((r) => setTimeout(r, 4000))
    }
    console.log('[feed] done')
  }
  if (process.env.JARVIS_TEST_OVERLAY) {
    // dev: show the "Jarvis is controlling the PC" overlay for 8 s (check that it stays see-through)
    await new Promise((r) => setTimeout(r, 4000))
    console.log('[overlay-test] on')
    await assistant.overlay.setControl(true, 'управляет компьютером · Ctrl+Alt+K — стоп')
    await new Promise((r) => setTimeout(r, 8000))
    await assistant.overlay.setControl(false)
    console.log('[overlay-test] off')
  }
  if (process.env.JARVIS_TEST_DOCS) {
    // dev / packaged self-test of the document toolkit: diagram, image search, deck, PDF, read back
    const out = process.env.JARVIS_TEST_DOCS
    const d = await import('./docs')
    const step = async (name: string, f: () => Promise<unknown>) => {
      try {
        console.log(`[docs-test] ${name}: ${String(await f()).split('\n')[0]}`)
      } catch (e: any) {
        console.log(`[docs-test] ${name}: FAIL ${e?.message || e}`)
      }
    }
    await step('diagram', async () => (await d.makeDiagram('flowchart LR\n  A["Голос"] --> B["Агент"] --> C["Документ"]', 'midnight', 1000, join(out, 'diagram.png'))).path)
    let img = ''
    await step('images', async () => ((img = (await d.findImages('Moscow Kremlin', 1, 'landscape'))[0].path), img))
    await step('deck', () => d.createDeck({ title: 'Self-test', theme: 'clean', slides: [{ layout: 'title' }, { layout: 'diagram', title: 'Схема', diagram: 'pie title Доли\n  "A" : 60\n  "B" : 40' }, { layout: 'image', title: 'Фото', image: img }] }, { path: join(out, 'self-test.pptx'), overwrite: true }))
    await step('pdf', () => d.createDocument({ title: 'Self-test', template: 'modern', blocks: [{ type: 'paragraph', text: 'PDF ok' }, { type: 'diagram', mermaid: 'flowchart TD\n  A --> B', caption: 'Схема' }] }, 'pdf', { path: join(out, 'self-test.pdf'), overwrite: true }))
    await step('read pdf', () => d.readDocument(join(out, 'self-test.pdf'), 200))
    await step('read pptx', () => d.readDocument(join(out, 'self-test.pptx'), 200))
    console.log('[docs-test] done')
  }
  if (process.env.JARVIS_TEST_CMD) {
    // dev: run typed commands through the real agent one after another ("cmd one;;cmd two") and log each turn's end
    await new Promise((r) => setTimeout(r, 5000))
    for (const cmd of process.env.JARVIS_TEST_CMD.split(';;')) {
      const t0 = Date.now()
      const done = new Promise<void>((r) => assistant.opencode.once('turnEnd', () => r()))
      console.log('[cmd-test] >>>', cmd)
      void assistant.handleCommand(cmd, 'text')
      await Promise.race([done, new Promise((r) => setTimeout(r, 15 * 60_000))])
      console.log(`[cmd-test] turn done in ${Math.round((Date.now() - t0) / 1000)} s`)
    }
    console.log('[cmd-test] all done')
  }
  if (process.env.JARVIS_TEST_SAY) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = assistant.settings()
    console.log('[say-test] voices:', st.voiceRu, st.voiceEn)
    for (const line of ['Добрый вечер, сэр. Все системы работают в штатном режиме.', 'Good evening, sir. Everything is in order.']) {
      const t0 = Date.now()
      await assistant.say(line)
      console.log(`[say-test] "${line.slice(0, 24)}…" done in ${Date.now() - t0}ms`)
    }
  }
  if (process.env.JARVIS_TEST_ACK) {
    await new Promise((r) => setTimeout(r, 6000))
    for (const lang of ['ru', 'ru', 'en', 'en']) {
      const t0 = Date.now()
      await assistant.ack(lang)
      console.log(`[ack-test] ${lang} played in ${Date.now() - t0}ms`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  if (process.env.JARVIS_TEST_CLONE) {
    const t0 = Date.now()
    assistant.xtts
      .synth('Добрый вечер, сэр.', 'ru', 1)
      .then((b) => console.log(`[clone-test] OK ${b.length} bytes in ${Date.now() - t0}ms`))
      .catch((e) => console.log('[clone-test] FAILED', e.message))
  }
  if (process.env.JARVIS_NARROW) {
    await new Promise((r) => setTimeout(r, 9000))
    mainWin?.setMinimumSize(560, 600)
    mainWin?.setSize(680, 760)
    await new Promise((r) => setTimeout(r, 1200))
    await mainWin?.webContents.executeJavaScript("window.__setPage('assistant'); window.__demoLong(); setTimeout(() => { const f=document.querySelector('.feed'); f && (f.scrollTop=f.scrollHeight) }, 300)")
    await new Promise((r) => setTimeout(r, 800))
    writeFileSync(join(process.env.JARVIS_NARROW, 'narrow.png'), (await mainWin!.webContents.capturePage()).toPNG())
    const info = await mainWin?.webContents.executeJavaScript("(() => { const m=[...document.querySelectorAll('.msg.assistant')].pop(); if(!m) return 'no msg'; const c=m.querySelector('.clamp'); const b=m.querySelector('.more'); const r=(e)=>e&&JSON.stringify(e.getBoundingClientRect()); return 'msg '+r(m)+' clamp '+r(c)+' more '+r(b)+' display:'+getComputedStyle(m).display })()")
    console.log('[narrow]', info)
    await mainWin?.webContents.executeJavaScript("document.querySelectorAll('.thread-bar .btn')[0]?.click()")
    await new Promise((r) => setTimeout(r, 1200))
    writeFileSync(join(process.env.JARVIS_NARROW, 'drawer.png'), (await mainWin!.webContents.capturePage()).toPNG())
  }
  if (process.env.JARVIS_PROMO) void import('./promo').then((m) => m.runPromo({ win: () => mainWin!, assistant, out: process.env.JARVIS_PROMO! }))
  if (process.env.JARVIS_SHOTS) void debugShots(process.env.JARVIS_SHOTS)
  if (process.env.JARVIS_PROMPTS) void debugPrompts(JSON.parse(process.env.JARVIS_PROMPTS))
})
