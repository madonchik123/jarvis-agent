// Diagrams and charts: Mermaid code → PNG, rendered off-screen by Chromium with colours that match the target
// document or slide theme. Covers flowcharts, sequence, class/ER, state, timeline, mindmap, gantt, quadrant, pie and
// xy (bar / line) charts.
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { PALETTES } from './pptx'

function mermaidJs() {
  const packaged = join(process.resourcesPath ?? '', 'vendor', 'mermaid.min.js')
  const dev = join(app.getAppPath(), 'resources', 'vendor', 'mermaid.min.js')
  const mod = join(app.getAppPath(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
  const cwd = join(process.cwd(), 'resources', 'vendor', 'mermaid.min.js')
  const p = [app.isPackaged ? packaged : dev, mod, cwd].find((x) => existsSync(x))
  if (!p) throw new Error('diagram engine (mermaid) is missing — reinstall Jarvis')
  return p
}

export type DiagramTheme = 'light' | 'gost' | keyof typeof PALETTES

function themeVars(theme: DiagramTheme) {
  if (theme === 'gost')
    return { bg: '#ffffff', vars: { background: '#ffffff', primaryColor: '#ffffff', primaryTextColor: '#000000', primaryBorderColor: '#000000', lineColor: '#000000', secondaryColor: '#f2f2f2', tertiaryColor: '#e6e6e6', textColor: '#000000', fontFamily: 'Times New Roman', pie1: '#404040', pie2: '#808080', pie3: '#bfbfbf', pie4: '#d9d9d9', pie5: '#595959', pie6: '#a6a6a6' } }
  const P = theme === 'light' ? PALETTES.clean : PALETTES[theme] ?? PALETTES.clean
  const c = (h: string) => '#' + h
  const series = [P.accent, P.accent2, P.dark ? 'F472B6' : 'F59E0B', P.dark ? 'FBBF24' : '10B981', P.dark ? 'A78BFA' : 'EF4444', P.dark ? '34D399' : '8B5CF6'].map(c)
  return {
    bg: c(P.bg),
    vars: {
      background: c(P.bg),
      primaryColor: c(P.surface),
      primaryTextColor: c(P.text),
      primaryBorderColor: c(P.accent),
      secondaryColor: c(P.dark ? P.surface : 'EEF2FF'),
      tertiaryColor: c(P.dark ? P.bg : 'F8FAFC'),
      lineColor: c(P.muted),
      textColor: c(P.text),
      titleColor: c(P.text),
      edgeLabelBackground: c(P.bg),
      clusterBkg: c(P.dark ? P.surface : 'F1F5FB'),
      clusterBorder: c(P.muted),
      nodeTextColor: c(P.text),
      fontFamily: 'Segoe UI',
      fontSize: '18px',
      pieStrokeColor: c(P.bg),
      pieTitleTextColor: c(P.text),
      pieSectionTextColor: P.dark ? c(P.bg) : '#ffffff',
      pieLegendTextColor: c(P.text),
      ...Object.fromEntries(series.map((s, i) => [`pie${i + 1}`, s])),
      cScale0: series[0],
      cScale1: series[1],
      cScale2: series[2],
      cScale3: series[3],
      xyChart: { backgroundColor: c(P.bg), titleColor: c(P.text), xAxisLabelColor: c(P.text), xAxisTitleColor: c(P.text), xAxisLineColor: c(P.muted), xAxisTickColor: c(P.muted), yAxisLabelColor: c(P.text), yAxisTitleColor: c(P.text), yAxisLineColor: c(P.muted), yAxisTickColor: c(P.muted), plotColorPalette: series.join(',') }
    }
  }
}

/** Renders Mermaid source to a PNG at `out` (2× pixel density); throws with Mermaid's own message on syntax errors. */
export async function renderMermaid(code: string, out: string, o: { theme?: DiagramTheme; width?: number; transparent?: boolean } = {}): Promise<{ path: string; w: number; h: number }> {
  const { bg, vars } = themeVars(o.theme ?? 'light')
  const width = Math.max(400, Math.min(2000, o.width ?? 1200))
  const dir = join(tmpdir(), 'jarvis-diagram')
  mkdirSync(dir, { recursive: true })
  const html = join(dir, `d-${Date.now()}.html`)
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${o.transparent ? 'transparent' : bg}}#c{display:inline-block;padding:24px}#c svg{max-width:none!important;height:auto}</style>
     <script src="${pathToFileURL(mermaidJs()).href}"></script></head><body><div id="c"></div></body></html>`
  )
  const win = new BrowserWindow({ show: false, width, height: 800, useContentSize: true, transparent: !!o.transparent, webPreferences: { offscreen: true, sandbox: false, contextIsolation: true } })
  try {
    await win.loadFile(html)
    const r = await win.webContents.executeJavaScript(`(async () => {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: ${JSON.stringify(vars)}, flowchart: { htmlLabels: true, curve: 'basis' }, xyChart: { width: ${Math.min(820, width - 48)}, height: ${Math.round(Math.min(820, width - 48) * 0.58)}, titleFontSize: 20, xAxis: { labelFontSize: 15 }, yAxis: { labelFontSize: 15 } }, pie: { textPosition: 0.72 } })
        const { svg } = await mermaid.render('d' + Date.now(), ${JSON.stringify(code)})
        const c = document.getElementById('c')
        c.innerHTML = svg
        const s = c.querySelector('svg')
        const vb = s.viewBox && s.viewBox.baseVal
        const natural = vb && vb.width ? vb.width : s.getBoundingClientRect().width
        s.style.width = Math.min(${width - 48}, Math.max(natural, ${Math.round(width * 0.5)})) + 'px'
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const b = c.getBoundingClientRect()
        return { ok: true, w: Math.ceil(b.width), h: Math.ceil(b.height) }
      } catch (e) { return { ok: false, error: String(e && e.message || e) } }
    })()`)
    if (!r.ok) throw new Error('diagram syntax error: ' + String(r.error).slice(0, 400))
    win.setContentSize(Math.max(r.w, 50), Math.max(r.h, 50))
    win.webContents.setZoomFactor(1)
    await new Promise((res) => setTimeout(res, 150))
    // render again at 2× for crisp text in documents and on projectors
    win.setContentSize(r.w * 2, r.h * 2)
    win.webContents.setZoomFactor(2)
    await new Promise((res) => setTimeout(res, 350))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: r.w * 2, height: r.h * 2 })
    mkdirSync(join(out, '..'), { recursive: true })
    writeFileSync(out, img.toPNG())
    const sz = img.getSize()
    return { path: out, w: sz.width, h: sz.height }
  } finally {
    win.destroy()
    rmSync(html, { force: true })
  }
}
