// Renders promo/compose.html frame by frame (deterministic, off-screen) and encodes the TikTok video.
//   npx electron promo/render.cjs                      → promo/out/jarvis-promo-tiktok.mp4
//   PROMO_STILLS=1,5,10 npx electron promo/render.cjs  → stills at those seconds in promo/build/preview
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const here = __dirname
const FPS = 30
app.commandLine.appendSwitch('disable-gpu-vsync')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 540, height: 960, useContentSize: true, show: false, webPreferences: { offscreen: true, contextIsolation: false, webSecurity: false, backgroundThrottling: false } })
  win.setContentSize(1080, 1920) // off-screen windows may exceed the display; the constructor would clamp it
  win.webContents.setFrameRate(60)
  await win.loadFile(join(here, 'compose.html'))
  await new Promise((r) => setTimeout(r, 800))
  const total = await win.webContents.executeJavaScript('window.PROMO.total')
  const grab = async (t) => {
    await win.webContents.executeJavaScript(`window.renderAt(${t})`)
    await new Promise((r) => setTimeout(r, 40))
    const img = await win.webContents.capturePage()
    if (!grab.logged) { grab.logged = true; console.log('frame size', JSON.stringify(img.getSize())) }
    return img.toJPEG(95)
  }

  if (process.env.PROMO_STILLS) {
    const dir = join(here, 'build', 'preview')
    mkdirSync(dir, { recursive: true })
    for (const s of process.env.PROMO_STILLS.split(',')) {
      writeFileSync(join(dir, `t${s}.jpg`), await grab(parseFloat(s)))
      console.log('still', s)
    }
    return app.quit()
  }

  const out = join(here, 'out')
  mkdirSync(out, { recursive: true })
  const mp4 = join(out, 'jarvis-promo-tiktok.mp4')
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', '-', '-i', join(here, 'build', 'audio.wav'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-movflags', '+faststart', '-shortest', mp4], { stdio: ['pipe', 'inherit', 'inherit'] })
  const frames = Math.round(total * FPS)
  for (let i = 0; i < frames; i++) {
    const buf = await grab(i / FPS)
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    if (i % 60 === 0) console.log(`frame ${i}/${frames}`)
  }
  ff.stdin.end()
  await new Promise((r) => ff.on('close', r))
  console.log('done', mp4)
  app.quit()
})
