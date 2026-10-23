// PDF generator: renders a DocSpec as styled HTML and prints it with Chromium (hidden window) — and the fallback
// DOCX → PDF path for PCs without Word or LibreOffice.
import { BrowserWindow } from 'electron'
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { DocSpec, DocTemplate } from './spec'
import { inlineRuns, imageSize } from './spec'
import { isRussian } from './docx'
import { loadZip, styleNames, paragraphKind } from './read'
import { splitBody, allParagraphs, wText } from './xml'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s: string) => inlineRuns(s).map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : r.italic ? `<i>${esc(r.text)}</i>` : r.code ? `<code>${esc(r.text)}</code>` : esc(r.text))).join('')

const CSS: Record<DocTemplate, string> = {
  gost: `@page{size:A4;margin:20mm 15mm 20mm 30mm} body{font:14pt/1.5 'Times New Roman',serif;color:#000;text-align:justify}
    p{margin:0;text-indent:1.25cm} h1{font-size:14pt;text-align:center;margin:0 0 18pt;break-before:page} h1.first{break-before:auto}
    h2,h3{font-size:14pt;margin:18pt 0 12pt;text-indent:1.25cm} table{border-collapse:collapse;width:100%;font-size:12pt}
    td,th{border:1px solid #000;padding:3pt 6pt;text-align:left;vertical-align:top} th{text-align:center}
    .cap{text-indent:0;margin:8pt 0 4pt} .figcap{text-align:center;text-indent:0;margin:4pt 0 12pt} ul,ol{margin:0;padding-left:1.9cm}
    blockquote{margin:8pt 0 8pt 1.25cm;font-style:italic} .note{background:#f2f2f2;padding:6pt 10pt;margin:8pt 0;text-indent:0}`,
  academic: `@page{size:A4;margin:25mm 20mm 25mm 25mm} body{font:12pt/1.5 'Times New Roman',serif;color:#111;text-align:justify}
    p{margin:0 0 6pt;text-indent:1cm} h1{font-size:15pt;color:#1F3864;margin:18pt 0 9pt} h2{font-size:13pt;color:#1F3864;margin:12pt 0 6pt} h3{font-size:12pt;color:#1F3864}
    table{border-collapse:collapse;width:100%;font-size:11pt} td,th{border:1px solid #9aa9c2;padding:3pt 6pt} th{background:#D9E2F3}
    .cap{margin:8pt 0 4pt;font-size:11pt} .figcap{text-align:center;font-size:11pt} blockquote{margin:8pt 1cm;font-style:italic;border-left:3px solid #1F3864;padding-left:10pt}
    .note{background:#eef2fa;padding:6pt 10pt;border-left:4px solid #1F3864}`,
  modern: `@page{size:A4;margin:20mm} body{font:11pt/1.5 Calibri,'Segoe UI',sans-serif;color:#1b2a41}
    p{margin:0 0 8pt} h1{font-size:20pt;color:#1F6FEB;border-bottom:2px solid #1F6FEB;padding-bottom:4pt;margin:22pt 0 8pt} h2{font-size:15pt;margin:16pt 0 6pt} h3{font-size:12.5pt;margin:12pt 0 4pt}
    table{border-collapse:collapse;width:100%;font-size:10pt;margin:4pt 0 10pt} td,th{border:1px solid #c9d3e0;padding:5pt 8pt} th{background:#1F6FEB;color:#fff} tr:nth-child(even) td{background:#f1f5fb}
    .cap{font-size:10pt;color:#5b6475;margin:10pt 0 4pt} .figcap{text-align:center;font-size:10pt;color:#5b6475} blockquote{margin:10pt 0;padding:4pt 14pt;border-left:4px solid #1F6FEB;font-style:italic;color:#334}
    .note{background:#eef4ff;border-left:4px solid #1F6FEB;padding:8pt 12pt;border-radius:4px}`,
  business: `@page{size:A4;margin:20mm 18mm} body{font:10.5pt/1.45 Arial,sans-serif;color:#1f2a2a}
    p{margin:0 0 7pt} h1{font-size:15pt;color:#0F766E;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #0F766E;padding-bottom:3pt;margin:20pt 0 7pt} h2{font-size:12.5pt;color:#134E4A;margin:14pt 0 5pt} h3{font-size:11pt;color:#134E4A}
    table{border-collapse:collapse;width:100%;font-size:9.5pt;margin:4pt 0 10pt} td,th{border:1px solid #c5d9d6;padding:4pt 7pt} th{background:#0F766E;color:#fff} tr:nth-child(even) td{background:#eef6f5}
    .cap{font-size:9.5pt;color:#4b5b5a;margin:10pt 0 4pt} .figcap{text-align:center;font-size:9.5pt;color:#4b5b5a} blockquote{border-left:4px solid #0F766E;margin:10pt 0;padding:2pt 12pt;font-style:italic}
    .note{background:#eef6f5;border-left:4px solid #0F766E;padding:8pt 12pt}`
}
const BASE = `*{box-sizing:border-box} img{max-width:100%} h1,h2,h3{break-after:avoid} tr,img,.figcap{break-inside:avoid}
  .titlepage{height:250mm;display:flex;flex-direction:column;text-indent:0;text-align:center;break-after:page}
  .titlepage .grow{flex:1} .titlepage .who{align-self:flex-end;text-align:left;width:46%} .titlepage p{text-indent:0}
  .cover{height:250mm;display:flex;flex-direction:column;justify-content:center;break-after:page} .cover h1.t{font-size:34pt;border:0;margin:0 0 8pt;break-before:auto}
  .cover .sub{font-size:15pt;color:#5b6475} .cover .meta{margin-top:18pt;color:#7a869a;font-size:10pt} .cover .bar{height:5px;width:90px;margin:16pt 0}
  .toc{break-after:page} .toc p{text-indent:0;margin:0 0 4pt} .toc .l2{padding-left:1cm} code{font-family:Consolas,monospace;font-size:.9em}`

export function specToHtml(spec: DocSpec): string {
  const tpl = spec.template ?? 'modern'
  const ru = isRussian(spec)
  const L = ru ? { table: 'Таблица', figure: 'Рисунок', toc: 'СОДЕРЖАНИЕ', sep: ' – ' } : { table: 'Table', figure: 'Figure', toc: 'Contents', sep: '. ' }
  const accent = { gost: '#000', academic: '#1F3864', modern: '#1F6FEB', business: '#0F766E' }[tpl]
  const out: string[] = []
  const tp = spec.title_page
  if (tp && (tpl === 'gost' || tpl === 'academic')) {
    out.push('<div class="titlepage">')
    for (const l of (tp.organization ?? '').split('\n').filter(Boolean)) out.push(`<p>${esc(l.toUpperCase())}</p>`)
    if (tp.faculty) out.push(`<p>${esc(tp.faculty)}</p>`)
    if (tp.department) out.push(`<p>${esc(tp.department)}</p>`)
    out.push('<div class="grow"></div>')
    out.push(`<p style="font-size:18pt;font-weight:bold">${esc((tp.work_type ?? 'КУРСОВАЯ РАБОТА').toUpperCase())}</p>`)
    if (tp.discipline) out.push(`<p>по дисциплине «${esc(tp.discipline)}»</p>`)
    if (tp.topic ?? spec.title) out.push(`<p><b>на тему: «${esc(tp.topic ?? spec.title ?? '')}»</b></p>`)
    out.push('<div class="grow"></div><div class="who">')
    if (tp.author ?? spec.author) out.push(`<p>Выполнил(а): ${esc(tp.author ?? spec.author ?? '')}</p>`)
    if (tp.group) out.push(`<p>Группа: ${esc(tp.group)}</p>`)
    if (tp.supervisor) out.push(`<p>Руководитель: ${esc(tp.supervisor)}</p>`)
    out.push('</div><div class="grow"></div>')
    out.push(`<p>${esc([tp.city, tp.year ?? String(new Date().getFullYear())].filter(Boolean).join(' '))}</p></div>`)
  } else if (spec.title && tpl !== 'gost') {
    out.push(`<div class="${tp ? 'cover' : ''}"><h1 class="t first" style="color:${accent};border:0;font-size:${tp ? 34 : 26}pt;margin-top:0">${esc(spec.title)}</h1>`)
    if (spec.subtitle) out.push(`<div class="sub">${esc(spec.subtitle)}</div>`)
    out.push(`<div class="bar" style="background:${accent};height:4px;width:90px;margin:12pt 0"></div><div class="meta">${esc([spec.author, new Date().toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })].filter(Boolean).join(' · '))}</div></div>`)
  }
  if (spec.toc) {
    const hs = spec.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.type === 'heading' && (x.b.level ?? 1) <= 2)
    out.push(`<div class="toc"><h1 class="first" style="text-align:${tpl === 'gost' ? 'center' : 'left'}">${L.toc}</h1>${hs.map((x) => `<p class="l${x.b.level ?? 1}"><a href="#h${x.i}" style="color:inherit;text-decoration:none">${esc(x.b.text ?? '')}</a></p>`).join('')}</div>`)
  }
  let tables = 0
  let figs = 0
  let first = true
  spec.blocks.forEach((b, i) => {
    switch (b.type) {
      case 'heading': {
        const l = Math.min(3, Math.max(1, b.level ?? 1))
        out.push(`<h${l} id="h${i}" class="${l === 1 && first ? 'first' : ''}">${esc(b.text ?? '')}</h${l}>`)
        if (l === 1) first = false
        break
      }
      case 'paragraph':
        out.push(`<p>${inline(b.text ?? '')}</p>`)
        break
      case 'note':
        out.push(`<p class="note">${inline(b.text ?? '')}</p>`)
        break
      case 'quote':
        out.push(`<blockquote>${inline(b.text ?? '')}${b.caption ? `<div style="text-align:right;font-style:normal">— ${esc(b.caption)}</div>` : ''}</blockquote>`)
        break
      case 'bullets':
        out.push(`<ul${tpl === 'gost' ? ' style="list-style:\'– \'"' : ''}>${(b.items ?? []).map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`)
        break
      case 'numbered':
      case 'references':
        out.push(`<ol>${(b.items ?? []).map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`)
        break
      case 'pagebreak':
        out.push('<div style="break-after:page"></div>')
        break
      case 'table':
        tables++
        if (b.caption) out.push(`<p class="cap">${L.table} ${tables}${L.sep}${esc(b.caption)}</p>`)
        out.push(`<table>${b.header ? `<tr>${b.header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>` : ''}${(b.rows ?? []).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`)
        break
      case 'image': {
        if (!b.path || !existsSync(b.path)) break
        const data = readFileSync(b.path)
        const sz = imageSize(data)
        if (!sz) break
        figs++
        const mime = sz.type === 'jpg' ? 'jpeg' : sz.type
        out.push(`<p style="text-align:center;text-indent:0;margin:10pt 0 4pt"><img src="data:image/${mime};base64,${data.toString('base64')}" style="width:${Math.min(b.width ?? 600, 620)}px"></p>`)
        if (b.caption) out.push(`<p class="figcap">${L.figure} ${figs}${L.sep}${esc(b.caption)}</p>`)
        if (b.credit) out.push(`<p class="figcap" style="font-size:8pt;color:#6b7280">${ru ? 'Источник' : 'Source'}: ${esc(b.credit)}</p>`)
        break
      }
    }
  })
  return `<!doctype html><html lang="${ru ? 'ru' : 'en'}"><head><meta charset="utf-8"><title>${esc(spec.title ?? '')}</title><style>${BASE}${CSS[tpl] ?? CSS.modern}</style></head><body>${out.join('\n')}</body></html>`
}

export async function htmlToPdf(html: string, opts: { pageNumbers?: boolean } = {}): Promise<Buffer> {
  const dir = join(tmpdir(), 'jarvis-pdf')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `doc-${Date.now()}.html`)
  writeFileSync(file, html)
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false, javascript: false, sandbox: true } })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: opts.pageNumbers !== false,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#666;font-family:Segoe UI,Arial"><span class="pageNumber"></span></div>'
    })
  } finally {
    win.destroy()
    rmSync(file, { force: true })
  }
}

/** Lossy DOCX → HTML (headings, paragraphs, lists, tables) for PDF export when no Office app is installed. */
export async function docxToHtml(path: string): Promise<string> {
  const zip = await loadZip(path)
  const xml = await zip.file('word/document.xml')!.async('string')
  const styles = await styleNames(zip)
  const parts: string[] = []
  for (const it of splitBody(xml).items) {
    if (it.kind === 'p') {
      const t = wText(it.xml).trim()
      if (!t) continue
      const k = paragraphKind(it.xml, styles)
      const centered = /<w:jc w:val="center"\/>/.test(it.xml)
      parts.push(k.heading ? `<h${Math.min(3, k.heading)}>${esc(t)}</h${Math.min(3, k.heading)}>` : k.list ? `<ul><li>${esc(t)}</li></ul>` : `<p${centered ? ' style="text-align:center;text-indent:0"' : ''}>${esc(t)}</p>`)
    } else if (it.kind === 'tbl') {
      const rows = allParagraphs(it.xml, 'w:tr').map((r) => `<tr>${allParagraphs(r.xml, 'w:tc').map((c) => `<td>${esc(allParagraphs(c.xml).map((p) => wText(p.xml)).join(' '))}</td>`).join('')}</tr>`)
      parts.push(`<table>${rows.join('')}</table>`)
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}${CSS.modern}</style></head><body>${parts.join('\n').replace(/<\/ul>\n<ul>/g, '')}</body></html>`
}
