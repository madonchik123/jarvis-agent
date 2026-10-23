// Small helpers for the Office Open XML parts we read and patch (document.xml, slideN.xml, sharedStrings.xml).
// Regex-based on purpose: the parts are machine-written and we only touch paragraphs, runs and text.

export const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&')

export const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One body-level item of a Word document, in order. `xml` is the exact source slice. */
export interface BodyItem {
  kind: 'p' | 'tbl' | 'other'
  xml: string
}

/** Splits <w:body> into its top-level paragraphs and tables (sectPr and anything else are kept as 'other'). */
export function splitBody(documentXml: string): { head: string; items: BodyItem[]; tail: string } {
  const open = documentXml.indexOf('<w:body>')
  const close = documentXml.lastIndexOf('</w:body>')
  if (open < 0 || close < 0) throw new Error('not a Word document body')
  const head = documentXml.slice(0, open + 8)
  const body = documentXml.slice(open + 8, close)
  const tail = documentXml.slice(close)
  const items: BodyItem[] = []
  let i = 0
  while (i < body.length) {
    const lt = body.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) items.push({ kind: 'other', xml: body.slice(i, lt) })
    const tag = /^<([\w:]+)/.exec(body.slice(lt, lt + 40))?.[1] ?? ''
    const end = elementEnd(body, lt, tag)
    const xml = body.slice(lt, end)
    items.push({ kind: tag === 'w:p' ? 'p' : tag === 'w:tbl' ? 'tbl' : 'other', xml })
    i = end
  }
  return { head, items, tail }
}

/** End index (exclusive) of the element starting at `start` (handles nesting of the same tag and self-closing). */
export function elementEnd(s: string, start: number, tag: string): number {
  const gt = s.indexOf('>', start)
  if (s[gt - 1] === '/') return gt + 1
  const re = new RegExp(`<${tag.replace(':', '\\:')}(?=[\\s>/])[^>]*?(/?)>|</${tag.replace(':', '\\:')}>`, 'g')
  re.lastIndex = start
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m[0].startsWith('</')) depth--
    else if (!m[1]) depth++
    if (depth === 0) return m.index + m[0].length
  }
  return s.length
}

/** All <w:p> elements anywhere inside xml (paragraphs in tables included), with their offsets. */
export function allParagraphs(xml: string, tag = 'w:p'): { start: number; end: number; xml: string }[] {
  const out: { start: number; end: number; xml: string }[] = []
  const re = new RegExp(`<${tag.replace(':', '\\:')}(?=[\\s>/])`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const end = elementEnd(xml, m.index, tag)
    out.push({ start: m.index, end, xml: xml.slice(m.index, end) })
    re.lastIndex = end
  }
  return out
}

/** Visible text of a Word paragraph (w:t, tabs, breaks). */
export function wText(p: string): string {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:t\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(p))) out += m[0].startsWith('<w:tab') ? '\t' : m[0].startsWith('<w:br') ? '\n' : decode(m[1] ?? '')
  return out
}

/** Visible text of a DrawingML paragraph (a:t). */
export function aText(p: string): string {
  let out = ''
  const re = /<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(p))) out += m[0] === '<a:br/>' ? '\n' : decode(m[1])
  return out
}

export const attr = (xml: string, name: string) => new RegExp(`${name.replace(':', '\\:')}="([^"]*)"`).exec(xml)?.[1]
