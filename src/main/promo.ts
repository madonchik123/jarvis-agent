/**
 * Promo-video capture (developer tool, only runs with JARVIS_PROMO=<dir>; see /promo).
 * Renders the real UI off-screen at a chosen size and records it as a JPEG sequence while scripted scenes drive the real
 * assistant (real agent runs, real computer use). The video itself is composed by promo/*.mjs.
 */
import { BrowserWindow } from 'electron'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import type { Assistant } from './assistant'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// portrait scenes are shown as a phone-style app: no title bar, no rail
const PORTRAIT_CSS = `.titlebar{display:none!important}.rail{display:none!important}.app{grid-template-rows:1fr!important}.body{grid-template-columns:1fr!important}.content{padding:18px 16px 18px 16px!important}`

export async function runPromo(o: { win: () => BrowserWindow; assistant: Assistant; out: string }) {
  const { assistant: A } = o
  const win = o.win()
  const wc = win.webContents
  mkdirSync(o.out, { recursive: true })
  wc.setFrameRate(30)

  let dir = ''
  let rec = false
  let t0 = 0
  let n = 0
  let times: number[] = []
  wc.on('paint', (_e, _d, image) => {
    if (!rec) return
    const t = Date.now() - t0
    writeFileSync(join(dir, `f${String(n++).padStart(5, '0')}.jpg`), image.toJPEG(92))
    times.push(t)
  })
  const js = (code: string) => wc.executeJavaScript(code)
  const only = process.env.JARVIS_PROMO_ONLY?.split(',')
  const want = (n: string) => !only || only.includes(n)
  // wait for the renderer to boot (debug helpers exist and the first state has arrived)
  for (let i = 0; i < 120; i++) {
    if (await js("typeof window.__setPage === 'function' && window.__app.getState().ready").catch(() => false)) break
    await sleep(500)
  }
  await sleep(1500)

  let cssKey: string | null = null
  async function view(w: number, h: number, zoom: number, portrait: boolean) {
    if (cssKey) await wc.removeInsertedCSS(cssKey).catch(() => {})
    cssKey = portrait ? await wc.insertCSS(PORTRAIT_CSS) : null
    win.setContentSize(w, h)
    wc.setZoomFactor(zoom)
    await sleep(900)
  }
  async function start(name: string) {
    dir = join(o.out, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    n = 0
    times = []
    t0 = Date.now()
    rec = true
    wc.invalidate()
  }
  function stop(name: string, extra: Record<string, unknown> = {}) {
    rec = false
    const dur = Date.now() - t0
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name, durationMs: dur, frames: n, times, ...extra }))
    console.log(`[promo] ${name}: ${n} frames, ${(dur / 1000).toFixed(1)} s`)
  }

  const turnDone = (maxMs: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, maxMs)
      A.opencode.once('turnEnd', () => {
        clearTimeout(t)
        resolve()
      })
    })

  async function chat(name: string, prompt: string, maxMs: number, extra: () => Record<string, unknown> = () => ({})) {
    if (!want(name)) return
    await A.opencode.newThread()
    await sleep(500)
    await js("window.__setPage('assistant')")
    await sleep(800)
    await start(name)
    await sleep(1200)
    const done = turnDone(maxMs)
    void A.handleCommand(prompt, 'voice', 'ru')
    // the viewer should see the consent card being accepted
    let running = true
    const approver = (async () => {
      while (running) {
        await sleep(900)
        await js("(() => { const b = [...document.querySelectorAll('button')].find((x) => /Разрешить для чата/.test(x.textContent || '')); if (b) setTimeout(() => b.click(), 1500) })()").catch(() => {})
      }
    })()
    await done
    if (A.opencode.isBusy) await A.opencode.abort().catch(() => {}) // never let an over-time turn leak into the next scene
    running = false
    await approver
    await sleep(2600)
    stop(name, extra())
  }

  if (process.env.JARVIS_PROMO_SET === 'v2') return runV2()
  if (process.env.JARVIS_PROMO_SET === 'v3') return runV3()

  // ---------------------------------------------------------------- v3: a spoken question through the real speech engine
  // JARVIS_PROMO_WAV = 16 kHz mono 16-bit wav of someone saying the request; it is fed like microphone input (real time),
  // so recognition, the agent run and the answer are all real.
  async function runV3() {
    await view(1080, 1920, 2, true)
    await A.opencode.newThread()
    await sleep(500)
    await js("window.__setPage('assistant')")
    await sleep(1500)
    for (let i = 0; i < 120 && !A.speech.ready; i++) await sleep(500) // speech models loaded
    const b = readFileSync(process.env.JARVIS_PROMO_WAV!)
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 44, b.byteOffset + b.length - ((b.length - 44) % 2)))
    const audio = new Float32Array(pcm.length + 16000 * 2) // + 2 s of silence so the end of speech is detected
    for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768
    const done = turnDone(240_000)
    await start('ask')
    await sleep(1500)
    const feedAt = Date.now() - t0
    for (let o = 0; o < audio.length; o += 1600) {
      A.speech.feed(audio.slice(o, o + 1600).buffer)
      await sleep(100)
    }
    await done
    await sleep(3500)
    stop('ask', { feedAtMs: feedAt, answer: '' })
    console.log('[promo] v3 done')
  }

  // ---------------------------------------------------------------- v2: harder real tasks, desktop recorded in a fixed stage
  async function runV2() {
    // the transparent full-screen overlay records as solid black with gdigrab, so it stays off while filming
    A.overlay.clear()
    await A.overlay.setControl(false)
    A.overlay.show = async () => {}
    A.overlay.setControl = async () => {}
    // where each app is placed the moment it appears (so the crop is stable); all inside the recorded stage
    const STAGE = { x: 0, y: 0, w: 1440, h: 1032 }
    const PLACE: Record<string, { x: number; y: number; w: number; h: number }> = {
      paint: { x: 20, y: 10, w: 1160, h: 1000 },
      calc: { x: 20, y: 10, w: 400, h: 620 },
      notepad: { x: 440, y: 10, w: 980, h: 760 }
    }
    const kindOf = (w: any) => {
      const s = `${w.title} ${w.process} ${w.app}`.toLowerCase()
      if (/mspaint|paint/.test(s)) return 'paint'
      if (/calculator|калькулятор/.test(s)) return 'calc'
      if (/notepad|блокнот/.test(s)) return 'notepad'
      return ''
    }
    const kill = async () => {
      for (const im of ['CalculatorApp.exe', 'mspaint.exe', 'Notepad.exe'])
        await new Promise<void>((r) => spawn('taskkill', ['/F', '/IM', im], { stdio: 'ignore' }).on('close', () => r()))
      // Notepad restores unsaved tabs on next start; drop the demo text so the next scene starts clean
      rmSync(join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe', 'LocalState', 'TabState'), { recursive: true, force: true })
      await sleep(1200)
    }

    async function task(name: string, prompt: string, maxMs: number) {
      if (!want(name)) return
      await kill()
      await A.win.call('desktop', { action: 'show_desktop' }, 20000).catch(() => {})
      await sleep(1500)
      const raw = join(o.out, `${name}.mkv`)
      const ff: ChildProcess = spawn(
        'ffmpeg',
        ['-y', '-f', 'gdigrab', '-framerate', '30', '-offset_x', String(STAGE.x), '-offset_y', String(STAGE.y), '-video_size', `${STAGE.w}x${STAGE.h}`, '-i', 'desktop', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', raw],
        { stdio: ['pipe', 'ignore', 'ignore'] }
      )
      const ffStart = Date.now()
      await sleep(1500)
      const rects: { t: number; kind: string; x: number; y: number; w: number; h: number; focused: boolean }[] = []
      const placed = new Set<number>()
      let polling = true
      const poll = (async () => {
        while (polling) {
          try {
            const ws = await A.win.call<any[]>('windows')
            for (const w of ws) {
              const k = kindOf(w)
              if (!k || w.minimized) continue
              const p = PLACE[k]
              if (!placed.has(w.hwnd)) {
                placed.add(w.hwnd)
                await A.win.call('window_control', { hwnd: w.hwnd, action: 'restore' }).catch(() => {})
                await A.win.call('window_control', { hwnd: w.hwnd, action: 'move', x: p.x, y: p.y }).catch(() => {})
                await A.win.call('window_control', { hwnd: w.hwnd, action: 'resize', width: p.w, height: p.h }).catch(() => {})
                continue
              }
              rects.push({ t: Date.now() - ffStart, kind: k, x: w.x - STAGE.x, y: w.y - STAGE.y, w: w.w, h: w.h, focused: !!w.focused })
            }
          } catch {}
          await sleep(250)
        }
      })()
      await chat(name, prompt, maxMs, () => ({ deskOffsetMs: t0 - ffStart }))
      await sleep(1500)
      polling = false
      await poll
      ff.stdin?.write('q')
      await sleep(2500)
      ff.kill()
      writeFileSync(join(o.out, `${name}_rects.json`), JSON.stringify({ stage: STAGE, rects }))
    }

    await view(1080, 1920, 2, true)
    await task('t_paint', 'Открой Paint и нарисуй смайлик: большой круг, два глаза и улыбку.', 600_000)
    await task('t_calc', 'Посчитай в калькуляторе 1337 умножить на 42, а потом открой Блокнот и запиши туда результат.', 240_000)
    await task('t_letter', 'Открой Блокнот и напечатай туда короткое заявление на отпуск на две недели с понедельника, от имени Тони Старка. Печатай прямо в окно, файл не сохраняй.', 240_000)
    await kill()
    await A.win.call('desktop', { action: 'restore_all' }, 20000).catch(() => {})
    console.log('[promo] v2 done')
  }

  // ---------------------------------------------------------------- scene: orb states (landscape, for the hook)
  await view(1770, 1140, 1.5, false)
  await js("window.__setPage('assistant')")
  await sleep(1200)
  if (want('orb')) {
  await start('orb')
  A.setState('idle')
  await sleep(1800)
  A.setState('listening')
  const phrase = 'джарвис, открой калькулятор и посчитай двенадцать на семь'
  for (let i = 1; i <= phrase.length; i += 2) {
    A.emit('partial', phrase.slice(0, i))
    await sleep(70)
  }
  await sleep(500)
  A.setState('thinking')
  await sleep(1700)
  A.setState('speaking')
  A.emit('subtitle', 'Готово, сэр. Двенадцать на семь — восемьдесят четыре.')
  await sleep(2600)
  A.emit('subtitle', '')
  A.setState('idle')
  await sleep(600)
  stop('orb')
  }

  // ---------------------------------------------------------------- scene: settings tour (landscape)
  await js("window.__setPage('settings')")
  await sleep(1000)
  if (want('settings')) {
  await start('settings')
  await sleep(1000)
  await js("document.querySelectorAll('.subnav-item')[2]?.click()")
  await sleep(1200)
  for (let i = 0; i < 24; i++) {
    await js(`document.querySelector('.settings-pane').scrollTop = ${i * 26}`)
    await sleep(80)
  }
  await sleep(500)
  await js("document.querySelectorAll('.subnav-item')[1]?.click()")
  await sleep(1500)
  await js("document.querySelectorAll('.subnav-item')[4]?.click()")
  await sleep(1500)
  await js("document.querySelectorAll('.subnav-item')[3]?.click()")
  await sleep(1200)
  stop('settings')
  }

  // ---------------------------------------------------------------- portrait scenes
  await view(1080, 1920, 2, true)

  await chat('chat_memory', 'Запомни: я люблю кофе без сахара, а по вечерам работаю над проектом Атлас.', 70_000)
  await chat('chat_routine', 'Создай голосовую команду «Доброе утро»: скажи «Доброе утро, сэр» и открой браузер. Только сохрани команду, ничего не запускай.', 70_000)

  if (want('pages')) {
    await js("window.__setPage('memory')")
    await sleep(900)
    await start('page_memory')
    await sleep(2500)
    stop('page_memory')
    await js("window.__setPage('routines')")
    await sleep(900)
    await start('page_routines')
    await sleep(2500)
    stop('page_routines')
  }

  // ---------------------------------------------------------------- scene: real computer use + desktop recording
  if (!want('chat_calc')) return
  // start from a closed calculator so the viewer sees it being opened and used
  await new Promise<void>((r) => spawn('taskkill', ['/F', '/IM', 'CalculatorApp.exe'], { stdio: 'ignore' }).on('close', () => r()))
  await sleep(1500)
  const raw = join(o.out, 'desktop.mkv')
  const ff: ChildProcess = spawn('ffmpeg', ['-y', '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'ignore', 'ignore'] })
  await sleep(2500)
  const rects: { t: number; x: number; y: number; w: number; h: number; title: string; focused: boolean }[] = []
  let polling = true
  const ffStart = Date.now() - 2500
  const poll = (async () => {
    while (polling) {
      try {
        const ws = await A.win.call<any[]>('windows')
        const c = ws.find((w) => /calculator|калькулятор/i.test(w.title + w.process))
        if (c) rects.push({ t: Date.now() - ffStart, x: c.x, y: c.y, w: c.w, h: c.h, title: c.title, focused: !!c.focused })
      } catch {}
      await sleep(700)
    }
  })()
  const startedAt = Date.now()
  await chat('chat_calc', 'Открой калькулятор и посчитай двенадцать умножить на семь.', 120_000, () => ({ chatStartedAtDesktopMs: startedAt - ffStart - 0 }))
  polling = false
  await poll
  ff.stdin?.write('q')
  await sleep(2500)
  ff.kill()
  writeFileSync(join(o.out, 'calc_rects.json'), JSON.stringify({ chatStartMs: startedAt - ffStart, rects }))
  console.log('[promo] done')
}
