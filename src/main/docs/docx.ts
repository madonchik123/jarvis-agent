// DOCX generator: turns a DocSpec into a properly styled Word document (real heading styles, numbering, TOC field,
// page numbers, captions) so it stays editable in Word instead of looking like pasted text.
import { readFileSync, existsSync } from 'fs'
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  convertMillimetersToTwip as mm
} from 'docx'
import type { DocBlock, DocSpec, DocTemplate, TitlePage } from './spec'
import { inlineRuns, imageSize } from './spec'

interface Theme {
  font: string
  size: number // half-points
  line: number // 240 = single
  after: number // twips after a paragraph
  indent: number // first-line indent (twips)
  justify: boolean
  margin: [number, number, number, number] // top right bottom left, mm
  accent: string
  h: { size: number; color: string; align: 'left' | 'center'; before: number; after: number; pageBreak?: boolean; caps?: boolean; border?: boolean }[]
  tableHeaderFill?: string
  tableHeaderColor?: string
  zebra?: string
  bullet: string
  captionSize: number
}

const THEMES: Record<DocTemplate, Theme> = {
  // ГОСТ 7.32 / typical university rules for курсовые и рефераты
  gost: {
    font: 'Times New Roman', size: 28, line: 360, after: 0, indent: 709, justify: true, margin: [20, 15, 20, 30], accent: '000000',
    h: [
      { size: 28, color: '000000', align: 'center', before: 0, after: 360, pageBreak: true },
      { size: 28, color: '000000', align: 'left', before: 360, after: 240 },
      { size: 28, color: '000000', align: 'left', before: 240, after: 120 }
    ],
    bullet: '–', captionSize: 28
  },
  academic: {
    font: 'Times New Roman', size: 24, line: 360, after: 120, indent: 567, justify: true, margin: [25, 20, 25, 25], accent: '1F3864',
    h: [
      { size: 30, color: '1F3864', align: 'left', before: 360, after: 180 },
      { size: 26, color: '1F3864', align: 'left', before: 240, after: 120 },
      { size: 24, color: '1F3864', align: 'left', before: 180, after: 80 }
    ],
    tableHeaderFill: 'D9E2F3', bullet: '•', captionSize: 22
  },
  modern: {
    font: 'Calibri', size: 22, line: 288, after: 160, indent: 0, justify: false, margin: [20, 20, 20, 20], accent: '1F6FEB',
    h: [
      { size: 40, color: '1F6FEB', align: 'left', before: 360, after: 160, border: true },
      { size: 30, color: '1B2A41', align: 'left', before: 280, after: 120 },
      { size: 25, color: '1B2A41', align: 'left', before: 200, after: 80 }
    ],
    tableHeaderFill: '1F6FEB', tableHeaderColor: 'FFFFFF', zebra: 'F1F5FB', bullet: '•', captionSize: 20
  },
  business: {
    font: 'Arial', size: 21, line: 276, after: 140, indent: 0, justify: false, margin: [20, 18, 20, 18], accent: '0F766E',
    h: [
      { size: 30, color: '0F766E', align: 'left', before: 320, after: 140, caps: true, border: true },
      { size: 25, color: '134E4A', align: 'left', before: 240, after: 100 },
      { size: 22, color: '134E4A', align: 'left', before: 180, after: 80 }
    ],
    tableHeaderFill: '0F766E', tableHeaderColor: 'FFFFFF', zebra: 'EEF6F5', bullet: '▪', captionSize: 19
  }
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]

export function isRussian(spec: DocSpec) {
  const sample = [spec.title, ...spec.blocks.slice(0, 20).map((b) => b.text ?? b.items?.join(' ') ?? '')].join(' ')
  return /[а-яё]/i.test(sample)
}

export async function buildDocx(spec: DocSpec): Promise<Buffer> {
  const tpl: DocTemplate = spec.template ?? 'modern'
  const T = THEMES[tpl] ?? THEMES.modern
  const ru = isRussian(spec)
  const L = ru ? { table: 'Таблица', figure: 'Рисунок', toc: 'СОДЕРЖАНИЕ', sep: ' – ', source: 'Источник' } : { table: 'Table', figure: 'Figure', toc: 'Contents', sep: '. ', source: 'Source' }
  const runs = (s: string, extra: Record<string, unknown> = {}) =>
    inlineRuns(s).map((r) => new TextRun({ text: r.text, bold: r.bold || undefined, italics: r.italic || undefined, font: r.code ? 'Consolas' : undefined, ...extra }))
  const body = (s: string, o: Record<string, unknown> = {}) =>
    new Paragraph({ children: runs(s), alignment: T.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT, indent: T.indent ? { firstLine: T.indent } : undefined, ...o })

  const children: (Paragraph | Table | TableOfContents)[] = []
  const tocEntries: { title: string; level: number }[] = []
  let tables = 0
  let figures = 0

  // ---- title page
  const tp = spec.title_page
  if (tp) children.push(...(tpl === 'gost' || tpl === 'academic' ? gostTitle(tp, spec, T) : modernTitle(spec, T)))
  else if (spec.title && tpl !== 'gost') children.push(...modernTitle(spec, T, false))

  // ---- table of contents (Word fills page numbers on open / when Jarvis refreshes it through Word)
  if (spec.toc) {
    for (const b of spec.blocks) if (b.type === 'heading' && (b.level ?? 1) <= 2 && b.text) tocEntries.push({ title: b.text, level: b.level ?? 1 })
    children.push(new Paragraph({ children: [new TextRun({ text: L.toc, bold: true, size: T.h[0].size, color: T.h[0].color })], alignment: tpl === 'gost' ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 240 } }))
    children.push(new TableOfContents(L.toc, { hyperlink: true, headingStyleRange: '1-2', cachedEntries: tocEntries }))
    children.push(new Paragraph({ children: [], pageBreakBefore: true }))
  }

  let firstH1 = true
  for (const b of spec.blocks) {
    switch (b.type) {
      case 'heading': {
        const lvl = Math.min(3, Math.max(1, b.level ?? 1))
        const hs = T.h[lvl - 1]
        // the first chapter right after the title page / TOC must not leave an empty page
        const brk = !!hs.pageBreak && !(firstH1 && (tp || spec.toc ? true : children.length === 0))
        if (lvl === 1) firstH1 = false
        children.push(new Paragraph({ heading: HEADINGS[lvl - 1], children: [new TextRun({ text: hs.caps ? (b.text ?? '').toUpperCase() : b.text ?? '' })], pageBreakBefore: brk || undefined }))
        break
      }
      case 'paragraph':
        children.push(body(b.text ?? ''))
        break
      case 'note':
        children.push(
          new Paragraph({
            children: runs(b.text ?? ''),
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: tpl === 'gost' ? 'F2F2F2' : 'EEF4FF' },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: T.accent, space: 8 } },
            indent: { left: 200, right: 200 },
            spacing: { before: 120, after: 200 }
          })
        )
        break
      case 'quote':
        children.push(
          new Paragraph({
            children: runs(b.text ?? '', { italics: true }),
            indent: { left: 720, right: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: T.accent, space: 10 } },
            spacing: { before: 160, after: 200 }
          })
        )
        if (b.caption) children.push(new Paragraph({ children: [new TextRun({ text: '— ' + b.caption })], alignment: AlignmentType.RIGHT, spacing: { after: 200 } }))
        break
      case 'bullets':
      case 'numbered':
      case 'references': {
        const instance = children.length // one numbering instance per list, so items count 1, 2, 3 and the next list restarts
        for (const it of b.items ?? [])
          children.push(
            new Paragraph({
              children: runs(it),
              numbering: { reference: b.type === 'bullets' ? 'bullets' : b.type === 'references' ? 'refs' : 'numbers', level: Math.min(2, Math.max(0, (b.level ?? 1) - 1)), instance: b.type === 'numbered' ? instance : undefined },
              alignment: T.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT
            })
          )
        break
      }
      case 'pagebreak':
        children.push(new Paragraph({ children: [], pageBreakBefore: true }))
        break
      case 'table': {
        tables++
        if (b.caption) children.push(new Paragraph({ children: [new TextRun({ text: `${L.table} ${tables}${L.sep}${b.caption}`, size: T.captionSize })], spacing: { before: 200, after: 80 }, keepNext: true }))
        children.push(table(b, T))
        children.push(new Paragraph({ children: [], spacing: { after: 120 } }))
        break
      }
      case 'image': {
        if (!b.path || !existsSync(b.path)) {
          children.push(body(`[image not found: ${b.path ?? ''}]`))
          break
        }
        const data = readFileSync(b.path)
        const sz = imageSize(data)
        if (!sz) {
          children.push(body(`[unsupported image: ${b.path}]`))
          break
        }
        figures++
        const maxW = Math.min(b.width ?? 600, 620)
        const w = Math.min(maxW, sz.w)
        const h = Math.round((sz.h * w) / sz.w)
        children.push(new Paragraph({ children: [new ImageRun({ type: sz.type, data, transformation: { width: w, height: h } })], alignment: AlignmentType.CENTER, spacing: { before: 160, after: 80 }, keepNext: true }))
        if (b.caption) children.push(new Paragraph({ children: [new TextRun({ text: `${L.figure} ${figures}${L.sep}${b.caption}`, size: T.captionSize })], alignment: AlignmentType.CENTER, spacing: { after: b.credit ? 0 : 240 } }))
        if (b.credit) children.push(new Paragraph({ children: [new TextRun({ text: `${L.source}: ${b.credit}`, size: Math.max(16, T.captionSize - 6), color: '6B7280' })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }))
        break
      }
    }
  }

  const headingStyles = T.h.map((hs, i) => ({
    id: `Heading${i + 1}`,
    name: `Heading ${i + 1}`,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    run: { font: T.font, size: hs.size, bold: true, color: hs.color },
    paragraph: {
      alignment: hs.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { before: hs.before, after: hs.after, line: tpl === 'gost' ? 360 : 240 },
      indent: tpl === 'gost' && i > 0 ? { firstLine: T.indent } : undefined,
      keepNext: true,
      keepLines: true,
      outlineLevel: i,
      border: hs.border ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: T.accent, space: 4 } } : undefined
    }
  }))
  const level = (fmt: (typeof LevelFormat)[keyof typeof LevelFormat], text: (n: number) => string) =>
    [0, 1, 2].map((l) => ({ level: l, format: fmt, text: text(l), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: (tpl === 'gost' ? 709 : 360) + l * 360 + 360, hanging: 360 } } } }))

  const doc = new Document({
    creator: spec.author || 'Jarvis',
    title: spec.title,
    description: spec.subtitle,
    features: { updateFields: !!spec.toc },
    styles: {
      default: { document: { run: { font: T.font, size: T.size }, paragraph: { spacing: { line: T.line, after: T.after } } } },
      paragraphStyles: headingStyles
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: level(LevelFormat.BULLET, (l) => [T.bullet, '◦', '▪'][l]) },
        { reference: 'numbers', levels: level(LevelFormat.DECIMAL, (l) => ['%1.', '%1.%2.', '%1.%2.%3.'][l]) },
        { reference: 'refs', levels: level(LevelFormat.DECIMAL, () => '%1.') }
      ]
    },
    sections: [
      {
        properties: {
          titlePage: !!tp,
          page: { margin: { top: mm(T.margin[0]), right: mm(T.margin[1]), bottom: mm(T.margin[2]), left: mm(T.margin[3]) } }
        },
        footers:
          spec.page_numbers === false
            ? undefined
            : {
                default: new Footer({
                  children: [new Paragraph({ alignment: tpl === 'gost' ? AlignmentType.CENTER : AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], size: tpl === 'gost' ? 24 : 18, color: tpl === 'gost' ? '000000' : '7A869A' })] })]
                }),
                first: new Footer({ children: [] })
              },
        children
      }
    ]
  })
  return Packer.toBuffer(doc)
}

function table(b: DocBlock, T: Theme): Table {
  const rows = [...(b.header ? [b.header] : []), ...(b.rows ?? [])]
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const border = { style: BorderStyle.SINGLE, size: 4, color: T.tableHeaderFill ? 'C9D3E0' : '000000' }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((r, ri) => {
      const head = !!b.header && ri === 0
      return new TableRow({
        tableHeader: head,
        cantSplit: true,
        children: Array.from({ length: cols }, (_, ci) =>
          new TableCell({
            shading: head && T.tableHeaderFill ? { type: ShadingType.CLEAR, color: 'auto', fill: T.tableHeaderFill } : !head && T.zebra && ri % 2 === 0 ? { type: ShadingType.CLEAR, color: 'auto', fill: T.zebra } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            children: [
              new Paragraph({
                alignment: head ? AlignmentType.CENTER : AlignmentType.LEFT,
                spacing: { line: 240, after: 0 },
                children: inlineRuns(r[ci] ?? '').map((x) => new TextRun({ text: x.text, bold: head || x.bold || undefined, italics: x.italic || undefined, color: head && T.tableHeaderColor ? T.tableHeaderColor : undefined, size: Math.min(T.size, 24) }))
              })
            ]
          })
        )
      })
    })
  })
}

function centered(text: string, o: { bold?: boolean; size?: number; caps?: boolean; before?: number; after?: number } = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: o.before ?? 0, after: o.after ?? 0, line: 276 },
    children: [new TextRun({ text: o.caps ? text.toUpperCase() : text, bold: o.bold, size: o.size })]
  })
}

/** Russian university title page (титульный лист) */
function gostTitle(tp: TitlePage, spec: DocSpec, T: Theme): Paragraph[] {
  const out: Paragraph[] = []
  for (const line of (tp.organization ?? '').split('\n').filter(Boolean)) out.push(centered(line, { size: T.size, caps: true }))
  if (tp.faculty) out.push(centered(tp.faculty, { size: T.size, before: 120 }))
  if (tp.department) out.push(centered(tp.department, { size: T.size }))
  out.push(centered(tp.work_type ?? 'КУРСОВАЯ РАБОТА', { bold: true, size: T.size + 8, caps: true, before: 2600, after: 160 }))
  if (tp.discipline) out.push(centered(`по дисциплине «${tp.discipline}»`, { size: T.size, after: 120 }))
  const topic = tp.topic ?? spec.title
  if (topic) out.push(centered(`на тему: «${topic}»`, { size: T.size, bold: true, after: 0 }))
  const right = (label: string, value?: string, before = 0) =>
    value ? new Paragraph({ indent: { left: mm(95) }, spacing: { before, line: 276 }, children: [new TextRun({ text: label, size: T.size }), new TextRun({ text: value, size: T.size })] }) : null
  const who = [
    right('Выполнил(а): ', tp.author ?? spec.author, 1800),
    right('Группа: ', tp.group),
    right('Руководитель: ', tp.supervisor, 200)
  ].filter(Boolean) as Paragraph[]
  out.push(...who)
  out.push(centered([tp.city, tp.year ?? String(new Date().getFullYear())].filter(Boolean).join(' '), { size: T.size, before: 2200 }))
  out.push(new Paragraph({ children: [], pageBreakBefore: true }))
  return out
}

/** Cover for modern / business documents (or a title block on the first page when there is no title page) */
function modernTitle(spec: DocSpec, T: Theme, page = true): Paragraph[] {
  const out: Paragraph[] = []
  out.push(new Paragraph({ spacing: { before: page ? 2800 : 0, after: 120 }, children: [new TextRun({ text: spec.title ?? '', bold: true, size: page ? 64 : 48, color: T.accent })] }))
  if (spec.subtitle) out.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: spec.subtitle, size: page ? 30 : 26, color: '5B6475' })] }))
  out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: T.accent, space: 1 } }, spacing: { after: 240 }, children: [] }))
  const meta = [spec.author, new Date().toLocaleDateString(isRussian(spec) ? 'ru-RU' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })].filter(Boolean).join(' · ')
  out.push(new Paragraph({ spacing: { after: page ? 0 : 240 }, children: [new TextRun({ text: meta, size: 20, color: '7A869A' })] }))
  if (page) out.push(new Paragraph({ children: [], pageBreakBefore: true }))
  return out
}
