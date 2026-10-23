/**
 * Promo-video capture (developer tool, only runs with JARVIS_PROMO=<dir>; see /promo).
 * Renders the real UI off-screen at a chosen size and records it as a JPEG sequence while scripted scenes drive the real
 * assistant (real agent runs, real computer use). The video itself is composed by promo/*.mjs.
 */
import { BrowserWindow } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
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
    running = false
    await approver
    await sleep(2600)
    stop(name, extra())
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
