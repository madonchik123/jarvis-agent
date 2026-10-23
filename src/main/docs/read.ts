// Reads office documents as compact, model-friendly text.
// DOCX paragraphs are numbered [#n] exactly as doc_edit counts them (top-level body paragraphs).
import { readFileSync } from 'fs'
import { extname } from 'path'
import JSZip from 'jszip'
import { splitBody, allParagraphs, wText, aText, attr, decode } from './xml'

export async function loadZip(path: string) {
  return JSZip.loadAsync(readFileSync(path))
}

/** styleId → lower-case style name ("heading 1", "title", "list paragraph" …); ids are localised in non-English Word. */
export async function styleNames(zip: JSZip): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  const xml = await zip.file('word/styles.xml')?.async('string')
  if (!xml) return m
  for (const s of allParagraphs(xml, 'w:style')) {
    const id = attr(s.xml, 'w:styleId')
    const name = /<w:name w:val="([^"]*)"/.exec(s.xml)?.[1]
    if (id && name) m.set(id, name.toLowerCase())
  }
  return m
}

export function paragraphKind(p: string, styles: Map<string, string>): { heading: number; list: boolean; style: string } {
  const id = /<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? ''
  const name = styles.get(id) ?? id.toLowerCase()
  const h = /^(?:heading|заголовок)\s*(\d)/.exec(name)?.[1] ?? (/^heading(\d)$/i.exec(id)?.[1] || '')
  const heading = name === 'title' || name === 'название' ? 1 : h ? +h : /<w:outlineLvl w:val="(\d)"/.test(p) ? +/<w:outlineLvl w:val="(\d)"/.exec(p)![1] + 1 : 0
  return { heading, list: /<w:numPr>/.test(p) || /list/.test(name), style: name || 'normal' }
}

async function readDocx(path: string) {
  const zip = await loadZip(path)
  const xml = await zip.file('word/document.xml')!.async('string')
  const styles = await styleNames(zip)
  const { items } = splitBody(xml)
  const out: string[] = []
  let pi = 0
  let ti = 0
  for (const it of items) {
    if (it.kind === 'p') {
      const n = pi++
      const t = wText(it.xml).trim()
      const hasImage = /<w:drawing>|<w:pict>/.test(it.xml)
      if (!t && !hasImage) continue
      const k = paragraphKind(it.xml, styles)
      const prefix = k.heading ? '#'.repeat(Math.min(k.heading, 4)) + ' ' : k.list ? '• ' : ''
      out.push(`[#${n}] ${prefix}${t}${hasImage ? ' [image]' : ''}`)
    } else if (it.kind === 'tbl') {
      ti++
      const rows = allParagraphs(it.xml, 'w:tr').map((r) => allParagraphs(r.xml, 'w:tc').map((c) => allParagraphs(c.xml).map((p) => wText(p.xml)).join(' ').trim()).join(' | '))
      out.push(`[table ${ti}]\n` + rows.map((r) => '  | ' + r + ' |').join('\n'))
    }
  }
  return { header: `DOCX · ${pi} paragraphs · ${ti} tables (numbers in [#n] are the paragraph indexes doc_edit uses)`, body: out.join('\n') }
}

async function readPptx(path: string) {
  const zip = await loadZip(path)
  const num = (f: string) => +(/(\d+)\.xml$/.exec(f)?.[1] ?? 0)
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => num(a) - num(b))
  const out: string[] = []
  for (const f of slides) {
    const xml = await zip.file(f)!.async('string')
    const lines: string[] = []
    for (const sp of allParagraphs(xml, 'p:sp')) {
      const isTitle = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(sp.xml)
      const paras = allParagraphs(sp.xml, 'a:p').map((p) => aText(p.xml).trim()).filter(Boolean)
      if (!paras.length) continue
      if (isTitle) lines.unshift('## ' + paras.join(' '))
      else lines.push(...paras.map((p) => '- ' + p))
    }
    for (const tb of allParagraphs(xml, 'a:tbl')) lines.push(...allParagraphs(tb.xml, 'a:tr').map((r) => '  | ' + allParagraphs(r.xml, 'a:tc').map((c) => aText(c.xml).trim()).join(' | ') + ' |'))
    if (/<p:pic>/.test(xml)) lines.push('[image]')
    const notes = await zip.file(`ppt/notesSlides/notesSlide${num(f)}.xml`)?.async('string')
    const nt = notes ? allParagraphs(notes, 'a:p').map((p) => aText(p.xml).trim()).filter((x) => x && !/^\d+$/.test(x)).join(' ') : ''
    out.push(`--- slide ${num(f)} ---\n${lines.join('\n')}${nt ? '\nnotes: ' + nt : ''}`)
  }
  return { header: `PPTX · ${slides.length} slides`, body: out.join('\n') }
}

async function readXlsx(path: string) {
  const zip = await loadZip(path)
  const ss = await zip.file('xl/sharedStrings.xml')?.async('string')
  const shared = ss ? allParagraphs(ss, 'si').map((s) => [...s.xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('')) : []
  const wb = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]))
  const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => +/(\d+)\.xml/.exec(a)![1] - +/(\d+)\.xml/.exec(b)![1])
  const out: string[] = []
  for (let si = 0; si < sheets.length; si++) {
    const xml = await zip.file(sheets[si])!.async('string')
    const rows = allParagraphs(xml, 'row').slice(0, 200)
    const lines = rows.map((r) =>
      allParagraphs(r.xml, 'c')
        .map((c) => {
          const ref = attr(c.xml, 'r') ?? ''
          const t = /\st="([^"]*)"/.exec(c.xml.slice(0, c.xml.indexOf('>')))?.[1]
          const v = /<v>([\s\S]*?)<\/v>/.exec(c.xml)?.[1]
          const f = /<f>([\s\S]*?)<\/f>/.exec(c.xml)?.[1]
          const val = t === 's' ? shared[+(v ?? -1)] ?? '' : t === 'inlineStr' ? decode(/<t[^>]*>([\s\S]*?)<\/t>/.exec(c.xml)?.[1] ?? '') : decode(v ?? '')
          return val || f ? `${ref}=${val}${f ? ` (=${decode(f)})` : ''}` : ''
        })
        .filter(Boolean)
        .join('\t')
    )
    out.push(`--- sheet "${names[si] ?? si + 1}" ---\n${lines.filter(Boolean).join('\n')}`)
  }
  return { header: `XLSX · ${sheets.length} sheets`, body: out.join('\n') }
}

async function readPdf(path: string) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)))
  const { totalPages, text } = await extractText(pdf, { mergePages: false })
  const pages = (text as string[]).map((t, i) => `--- page ${i + 1} ---\n${t.replace(/[ \t]+\n/g, '\n').trim()}`)
  const empty = (text as string[]).every((t) => !t.trim())
  return { header: `PDF · ${totalPages} pages${empty ? ' · no text layer (scanned?) — use OCR: open it and use screen tools' : ''}`, body: pages.join('\n') }
}

export async function readDocument(path: string, maxChars = 40000): Promise<string> {
  const ext = extname(path).toLowerCase()
  let r: { header: string; body: string }
  if (ext === '.docx' || ext === '.docm' || ext === '.dotx') r = await readDocx(path)
  else if (ext === '.pptx' || ext === '.pptm') r = await readPptx(path)
  else if (ext === '.xlsx' || ext === '.xlsm') r = await readXlsx(path)
  else if (ext === '.pdf') r = await readPdf(path)
  else if (ext === '.doc' || ext === '.ppt' || ext === '.xls' || ext === '.rtf' || ext === '.odt')
    throw new Error(`${ext} is an old/foreign format: convert it first with doc_convert (to "docx"/"pptx"/"pdf"), then read the result`)
  else {
    let t = readFileSync(path, 'utf8')
    if (ext === '.html' || ext === '.htm') t = decode(t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n')
    r = { header: `${ext.slice(1).toUpperCase() || 'TEXT'} · ${t.length} chars`, body: t }
  }
  const body = r.body.length > maxChars ? r.body.slice(0, maxChars) + `\n… [truncated: ${r.body.length - maxChars} more chars — read again with a larger max_chars]` : r.body
  return `${r.header}\n${body}`
}
