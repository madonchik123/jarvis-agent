// The document spec Jarvis writes (one shape for DOCX and PDF) and the deck spec (PPTX).

export type DocTemplate = 'gost' | 'modern' | 'business' | 'academic'

export interface DocBlock {
  type: 'heading' | 'paragraph' | 'bullets' | 'numbered' | 'table' | 'image' | 'diagram' | 'quote' | 'pagebreak' | 'references' | 'note'
  text?: string
  level?: number
  items?: string[]
  header?: string[]
  rows?: string[][]
  caption?: string
  path?: string
  width?: number
  /** diagram: Mermaid source, rendered to an image when the document is built */
  mermaid?: string
  /** image: attribution line (author, licence, source) — required for CC BY / BY-SA images */
  credit?: string
}

export interface TitlePage {
  organization?: string // ministry / university line(s), "\n" separated
  faculty?: string
  department?: string
  work_type?: string // "КУРСОВАЯ РАБОТА", "Реферат", "Отчёт по практике"
  discipline?: string
  topic?: string
  author?: string
  group?: string
  supervisor?: string
  city?: string
  year?: string
}

export interface DocSpec {
  title?: string
  subtitle?: string
  author?: string
  template?: DocTemplate
  title_page?: TitlePage
  toc?: boolean
  page_numbers?: boolean
  blocks: DocBlock[]
}

export interface SlideSpec {
  layout: 'title' | 'section' | 'bullets' | 'two_column' | 'image' | 'diagram' | 'quote' | 'stats' | 'table' | 'timeline' | 'closing'
  title?: string
  subtitle?: string
  bullets?: string[]
  left?: { title?: string; bullets?: string[] }
  right?: { title?: string; bullets?: string[] }
  image?: string
  quote?: string
  author?: string
  stats?: { value: string; label: string }[]
  steps?: { title: string; text?: string }[]
  header?: string[]
  rows?: string[][]
  notes?: string
  /** Mermaid source for a diagram / chart (layout "diagram", or the picture beside bullets) */
  diagram?: string
  caption?: string
  credit?: string
  /** how the picture fills its box: photos cover (cropped), diagrams contain (whole) */
  fit?: 'cover' | 'contain'
}

export interface DeckSpec {
  title: string
  subtitle?: string
  author?: string
  theme?: 'midnight' | 'clean' | 'ocean' | 'warm' | 'forest' | 'mono'
  slides: SlideSpec[]
}

/** **bold**, *italic*, `code` → runs */
export function inlineRuns(s: string): { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] {
  const out: { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] = []
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`/g
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > i) out.push({ text: s.slice(i, m.index) })
    if (m[1] != null) out.push({ text: m[1], bold: true })
    else if (m[2] != null) out.push({ text: m[2], italic: true })
    else out.push({ text: m[3], code: true })
    i = m.index + m[0].length
  }
  if (i < s.length) out.push({ text: s.slice(i) })
  return out.length ? out : [{ text: '' }]
}

/** width/height of a PNG / JPEG / GIF / BMP from its header (no image library needed) */
export function imageSize(b: Buffer): { w: number; h: number; type: 'png' | 'jpg' | 'gif' | 'bmp' } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' }
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' }
  if (b.length > 26 && b.toString('ascii', 0, 2) === 'BM') return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)), type: 'bmp' }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null
      const marker = b[o + 1]
      const len = b.readUInt16BE(o + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7), type: 'jpg' }
      o += 2 + len
    }
  }
  return null
}
