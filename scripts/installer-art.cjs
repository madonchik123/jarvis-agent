// Renders the NSIS installer artwork (sidebar 164x314 and header 150x57) from HTML with Electron, as PNG at 2x;
// ffmpeg then converts them to the 24-bit BMP NSIS needs:  npx electron scripts/installer-art.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')

const ORB = (s) => `
<div style="position:relative;width:${s}px;height:${s}px">
  <div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(56,214,255,.45) 0%,rgba(56,214,255,.08) 55%,transparent 70%)"></div>
  <div style="position:absolute;inset:${s * 0.08}px;border-radius:50%;border:1px solid rgba(56,214,255,.35)"></div>
  <div style="position:absolute;inset:${s * 0.13}px;border-radius:50%;border:${s * 0.012}px dotted #38d6ff;opacity:.9"></div>
  <div style="position:absolute;inset:${s * 0.21}px;border-radius:50%;border:${s * 0.03}px dashed rgba(56,214,255,.4)"></div>
  <div style="position:absolute;inset:${s * 0.31}px;border-radius:50%;background:radial-gradient(circle,#fff 0%,#c9f4ff 25%,#38d6ff 60%,transparent 100%);box-shadow:0 0 ${s * 0.2}px #38d6ff"></div>
</div>`

const pages = {
  sidebar: [164, 314, `<div style="width:164px;height:314px;background:linear-gradient(160deg,#0b1626,#060b14 60%,#0a0f1f);display:flex;flex-direction:column;align-items:center;font-family:'Segoe UI Semibold','Segoe UI';color:#eaf4ff;overflow:hidden">
     <div style="margin-top:46px">${ORB(120)}</div>
     <div style="margin-top:26px;font-size:17px;letter-spacing:.42em;padding-left:.42em;color:#38d6ff">JARVIS</div>
     <div style="margin-top:8px;font-size:10.5px;color:#8fa3ba;text-align:center;line-height:1.4;padding:0 14px">голосовой ИИ-агент<br>для Windows</div>
   </div>`],
  header: [150, 57, `<div style="width:150px;height:57px;background:#ffffff;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;box-sizing:border-box;font-family:'Segoe UI Semibold','Segoe UI'">
     <div style="font-size:13px;letter-spacing:.32em;color:#0b1626;margin-right:8px">JARVIS</div>
     <div style="width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,#fff 0%,#7de9ff 40%,#1aa6e0 80%);box-shadow:0 0 8px #38d6ff"></div>
   </div>`]
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const out = join(__dirname, '..', 'build')
  mkdirSync(out, { recursive: true })
  for (const [name, [w, h, html]] of Object.entries(pages)) {
    const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0">${html}</body></html>`))
    await new Promise((r) => setTimeout(r, 400))
    const img = await win.webContents.capturePage()
    const png = join(out, `installer-${name}.png`)
    writeFileSync(png, img.toPNG())
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-vf', `scale=${w}:${h}`, '-pix_fmt', 'bgr24', join(out, `installer-${name}.bmp`)])
    win.destroy()
    console.log('ok', name)
  }
  // multi-size icon for the installer / uninstaller
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(__dirname, '..', 'resources', 'icon.png'), '-vf', 'scale=256:256', join(out, 'icon.ico')])
  app.quit()
})
