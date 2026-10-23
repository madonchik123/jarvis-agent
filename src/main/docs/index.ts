// Document toolkit entry points used by the MCP tools (read / create / edit / convert office documents).
import { app, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join } from 'path'
import type { DeckSpec, DocSpec } from './spec'
import { buildDocx } from './docx'
import { buildPptx } from './pptx'
import { specToHtml, htmlToPdf, docxToHtml } from './pdf'
import { readDocument } from './read'
import { editDocx, editPptx, type EditOp } from './edit'
import { convertWithOffice, refreshToc, officeApps, type Target } from './office'
import { renderMermaid, type DiagramTheme } from './diagram'
import { searchImages } from './images'
import { createHash } from 'crypto'

export { readDocument, officeApps }
export type { DocSpec, DeckSpec, EditOp }

export const docsDir = () => join(app.getPath('documents'), 'Jarvis')
const backupDir = () => join(docsDir(), '.backups')
const assetsDir = () => join(docsDir(), '.assets')

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)

/** Mermaid → PNG (cached by source + theme) */
export async function makeDiagram(code: string, theme: DiagramTheme, width?: number, out?: string) {
  const p = out ? outPath(out, 'diagram', '.png', true) : join(assetsDir(), `diagram-${hash(theme + code)}-${width ?? 0}.png`)
  if (!out && existsSync(p)) return { path: p, w: 0, h: 0 }
  return renderMermaid(code, p, { theme, width })
}

export async function findImages(query: string, count?: number, orientation?: 'landscape' | 'portrait' | 'square' | 'any') {
  return searchImages(query, join(assetsDir(), 'images'), { count, orientation })
}

/** turns diagram blocks / slide diagrams into rendered images before the (pure) builders run */
async function prepareDoc(spec: DocSpec): Promise<DocSpec> {
  const blocks = []
  for (const [i, b] of spec.blocks.entries()) {
    if (b.type === 'diagram' || (b.type === 'image' && b.mermaid)) {
      if (!b.mermaid) continue
      try {
        const d = await makeDiagram(b.mermaid, spec.template === 'gost' ? 'gost' : 'light', 1100)
        blocks.push({ ...b, type: 'image' as const, path: d.path, width: b.width ?? 600 })
      } catch (e: any) {
        throw new Error(`block ${i} (diagram): ${e?.message || e}`)
      }
    } else blocks.push(b)
  }
  return { ...spec, blocks }
}

async function prepareDeck(spec: DeckSpec): Promise<DeckSpec> {
  const slides = []
  for (const [i, s] of spec.slides.entries()) {
    if (!s.diagram) {
      slides.push(s)
      continue
    }
    try {
      // beside bullets the box is tall and narrow: a left-to-right flow would shrink to nothing, so lay it out top-down
      const code = s.layout === 'bullets' ? s.diagram.replace(/^(\s*(?:flowchart|graph))\s+(LR|RL)\b/m, '$1 TD') : s.diagram
      const d = await makeDiagram(code, spec.theme ?? 'midnight', s.layout === 'bullets' ? 900 : 1500)
      slides.push({ ...s, image: d.path, fit: 'contain' as const, layout: s.layout === 'bullets' ? s.layout : ('diagram' as const) })
    } catch (e: any) {
      throw new Error(`slide ${i + 1} (diagram): ${e?.message || e}`)
    }
  }
  return { ...spec, slides }
}

/** absolute output path with the right extension; never silently replaces an existing file unless overwrite */
export function outPath(name: string | undefined, fallbackTitle: string, ext: string, overwrite = false): string {
  const safe = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document'
  let p = name ? (isAbsolute(name) ? name : join(docsDir(), name)) : join(docsDir(), safe(fallbackTitle))
  if (extname(p).toLowerCase() !== ext) p += ext
  mkdirSync(dirname(p), { recursive: true })
  if (overwrite || !existsSync(p)) return p
  for (let i = 2; ; i++) {
    const q = join(dirname(p), `${basename(p, ext)} (${i})${ext}`)
    if (!existsSync(q)) return q
  }
}

const open = (p: string) => void shell.openPath(p)

export async function createDocument(input: DocSpec, format: 'docx' | 'pdf', o: { path?: string; overwrite?: boolean; open?: boolean }) {
  const spec = await prepareDoc(input)
  const p = outPath(o.path, spec.title ?? spec.title_page?.topic ?? 'Документ', '.' + format, o.overwrite)
  const notes: string[] = []
  if (format === 'docx') {
    writeFileSync(p, await buildDocx(spec))
    if (spec.toc) {
      // Word computes real page numbers for the table of contents; without Word it updates on first open
      const ok = await Promise.race([refreshToc(p).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 90_000))])
      notes.push(ok ? 'table of contents filled by Word' : 'table of contents updates when the file is opened in Word (it asks to update fields)')
    }
  } else {
    writeFileSync(p, await htmlToPdf(specToHtml(spec), { pageNumbers: spec.page_numbers }))
  }
  if (o.open) open(p)
  const words = spec.blocks.reduce((n, b) => n + ((b.text ?? '') + ' ' + (b.items ?? []).join(' ') + ' ' + (b.rows ?? []).flat().join(' ')).split(/\s+/).filter(Boolean).length, 0)
  return `saved ${p}\n${spec.blocks.length} blocks, ~${words} words${notes.length ? '\n' + notes.join('\n') : ''}`
}

export async function createDeck(input: DeckSpec, o: { path?: string; overwrite?: boolean; open?: boolean; pdf?: boolean }) {
  const spec = await prepareDeck(input)
  const p = outPath(o.path, spec.title, '.pptx', o.overwrite)
  writeFileSync(p, await buildPptx(spec))
  let extra = ''
  if (o.pdf) {
    const pdf = p.replace(/\.pptx$/i, '.pdf')
    try {
      const via = await convertWithOffice(p, 'pdf', pdf)
      extra = `\nPDF copy (${via}): ${pdf}`
    } catch {
      extra = '\nno PowerPoint/LibreOffice on this PC, so no PDF copy (the .pptx opens in PowerPoint, Google Slides or LibreOffice)'
    }
  }
  if (o.open) open(p)
  return `saved ${p}\n${spec.slides.length} slides, theme ${spec.theme ?? 'midnight'}${extra}`
}

export async function editDocument(path: string, ops: EditOp[], o: { out?: string; open?: boolean }) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`)
  const ext = extname(path).toLowerCase()
  const out = o.out ? outPath(o.out, basename(path, ext), ext, true) : path
  const r = ext === '.docx' ? await editDocx(path, ops, out, backupDir()) : ext === '.pptx' ? await editPptx(path, ops, out, backupDir()) : null
  if (r == null) throw new Error(`editing ${ext} is not supported: convert it to .docx/.pptx with doc_convert first, or rebuild it`)
  let toc = ''
  if (ext === '.docx' && ops.some((x) => x.op !== 'replace_text')) {
    // headings may have moved: let Word rebuild the table of contents (only if the file has one)
    const xml = await (await (await import('./read')).loadZip(out)).file('word/document.xml')?.async('string')
    if (xml && /TOC \\o|w:sdtDocPart|TOC \\h/.test(xml)) {
      const ok = await Promise.race([refreshToc(out).catch(() => false), new Promise<boolean>((res) => setTimeout(() => res(false), 90_000))])
      toc = ok ? '\ntable of contents refreshed' : ''
    }
  }
  if (o.open) open(out)
  return r + toc
}

export async function convertDocument(path: string, to: Target, o: { out?: string; open?: boolean }) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`)
  const out = outPath(o.out ?? join(dirname(path), basename(path, extname(path))), basename(path), '.' + to)
  try {
    const via = await convertWithOffice(path, to, out)
    if (o.open) open(out)
    return `converted with ${via} → ${out}`
  } catch (e: any) {
    if (e?.message !== 'no-office') throw e
  }
  if (to === 'pdf' && extname(path).toLowerCase() === '.docx') {
    writeFileSync(out, await htmlToPdf(await docxToHtml(path)))
    if (o.open) open(out)
    return `converted (simplified layout — no Word/LibreOffice on this PC) → ${out}`
  }
  throw new Error('this conversion needs Microsoft Office or LibreOffice, and neither is installed')
}
