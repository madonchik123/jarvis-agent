// PPTX generator: designed 16:9 slides from a DeckSpec (themes, layouts, footers, speaker notes).
import { existsSync, readFileSync } from 'fs'
import PptxGenJS from 'pptxgenjs'
import type { DeckSpec, SlideSpec } from './spec'
import { imageSize } from './spec'

/** box for an image shown whole (no crop, no stretch), centred in the given area */
function contain(path: string, x: number, y: number, w: number, h: number) {
  const sz = imageSize(readFileSync(path))
  if (!sz) return { x, y, w, h }
  const r = Math.min(w / sz.w, h / sz.h)
  const iw = sz.w * r
  const ih = sz.h * r
  return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih }
}

interface Palette {
  bg: string
  surface: string
  text: string
  muted: string
  accent: string
  accent2: string
  dark: boolean
}

export const PALETTES: Record<NonNullable<DeckSpec['theme']>, Palette> = {
  midnight: { bg: '0B1220', surface: '16213A', text: 'E8EEF8', muted: '94A3B8', accent: '38BDF8', accent2: '818CF8', dark: true },
  clean: { bg: 'FFFFFF', surface: 'F1F5FB', text: '0F172A', muted: '64748B', accent: '2563EB', accent2: '0EA5E9', dark: false },
  ocean: { bg: '0A2540', surface: '10365E', text: 'F1F7FF', muted: '9FB3C8', accent: '00D4FF', accent2: '7DF9FF', dark: true },
  warm: { bg: 'FBF7F1', surface: 'F3EADF', text: '2B2118', muted: '7C6A58', accent: 'D9480F', accent2: 'F59F00', dark: false },
  forest: { bg: '0E1A14', surface: '17291F', text: 'E9F3EC', muted: '9DB5A6', accent: '34D399', accent2: 'A3E635', dark: true },
  mono: { bg: 'FFFFFF', surface: 'F4F4F5', text: '18181B', muted: '71717A', accent: '18181B', accent2: '52525B', dark: false }
}

const HEAD = 'Segoe UI Semibold'
const BODY = 'Segoe UI'
const W = 13.333
const H = 7.5
const MX = 0.75

/** font size that keeps a bullet list inside its box */
function fitSize(lines: string[], boxW: number, boxH: number, max = 24, min = 14) {
  for (let s = max; s > min; s -= 1) {
    const charsPerLine = Math.max(10, Math.floor((boxW * 72 * 1.9) / s))
    const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0)
    const need = (rows * s * 1.25 + lines.length * s * 0.55) / 72
    if (need <= boxH) return s
  }
  return min
}

export async function buildPptx(spec: DeckSpec): Promise<Buffer> {
  const P = PALETTES[spec.theme ?? 'midnight'] ?? PALETTES.midnight
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = spec.title
  pptx.author = spec.author || 'Jarvis'
  pptx.theme = { headFontFace: HEAD, bodyFontFace: BODY }
  const ru = /[а-яё]/i.test(spec.title + JSON.stringify(spec.slides).slice(0, 2000))
  const total = spec.slides.length

  spec.slides.forEach((s, i) => {
    const slide = pptx.addSlide()
    slide.background = { color: P.bg }
    const content = !['title', 'section', 'closing', 'image'].includes(s.layout)
    const title = (t: string, y = 0.45) => {
      slide.addText(t, { x: MX, y, w: W - 2 * MX, h: 0.95, fontFace: HEAD, fontSize: t.length > 60 ? 26 : 32, color: P.text, bold: true, valign: 'bottom', margin: 0 })
      slide.addShape(pptx.ShapeType.rect, { x: MX, y: y + 1.05, w: 0.9, h: 0.07, fill: { color: P.accent }, line: { color: P.accent } })
    }
    const bullets = (items: string[], x: number, y: number, w: number, h: number, max = 28) => {
      const size = fitSize(items, w, h, max)
      slide.addText(
        items.map((t) => ({ text: t, options: { bullet: { characterCode: '2022', indent: Math.round(size * 1.15) }, paraSpaceAfter: Math.round(size * 0.6), breakLine: true } })),
        { x, y, w, h, fontFace: BODY, fontSize: size, color: P.text, valign: 'top', margin: 2, lineSpacingMultiple: 1.05 }
      )
    }
    if (content) {
      slide.addText(spec.title, { x: MX, y: H - 0.5, w: 8, h: 0.3, fontFace: BODY, fontSize: 10, color: P.muted, margin: 0 })
      slide.addText(`${i + 1} / ${total}`, { x: W - MX - 2, y: H - 0.5, w: 2, h: 0.3, fontFace: BODY, fontSize: 10, color: P.muted, align: 'right', margin: 0 })
    }

    switch (s.layout) {
      case 'title': {
        slide.addShape(pptx.ShapeType.ellipse, { x: 8.6, y: -1.6, w: 6.4, h: 6.4, fill: { color: P.accent, transparency: 82 }, line: { color: P.accent, transparency: 100 } })
        slide.addShape(pptx.ShapeType.ellipse, { x: 10.2, y: 3.6, w: 4.2, h: 4.2, fill: { color: P.accent2, transparency: 86 }, line: { color: P.accent2, transparency: 100 } })
        slide.addShape(pptx.ShapeType.rect, { x: MX, y: 2.35, w: 1.2, h: 0.09, fill: { color: P.accent }, line: { color: P.accent } })
        slide.addText(s.title ?? spec.title, { x: MX, y: 2.55, w: 9.4, h: 1.9, fontFace: HEAD, fontSize: (s.title ?? spec.title).length > 50 ? 36 : 46, bold: true, color: P.text, valign: 'top', margin: 0 })
        const sub = s.subtitle ?? spec.subtitle
        if (sub) slide.addText(sub, { x: MX, y: 4.5, w: 9, h: 0.9, fontFace: BODY, fontSize: 20, color: P.muted, valign: 'top', margin: 0 })
        const meta = [spec.author, new Date().toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { year: 'numeric', month: 'long' })].filter(Boolean).join('  ·  ')
        slide.addText(meta, { x: MX, y: H - 1.0, w: 9, h: 0.4, fontFace: BODY, fontSize: 14, color: P.muted, margin: 0 })
        break
      }
      case 'section': {
        slide.background = { color: P.dark ? P.surface : P.accent }
        const fg = P.dark ? P.text : 'FFFFFF'
        const num = String(spec.slides.slice(0, i + 1).filter((x) => x.layout === 'section').length).padStart(2, '0')
        slide.addText(num, { x: MX, y: 1.2, w: 4, h: 2, fontFace: HEAD, fontSize: 110, bold: true, color: P.dark ? P.accent : 'FFFFFF', transparency: P.dark ? 0 : 35, margin: 0 })
        slide.addText(s.title ?? '', { x: MX, y: 3.3, w: W - 2 * MX, h: 1.4, fontFace: HEAD, fontSize: 42, bold: true, color: fg, margin: 0, valign: 'top' })
        if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 4.8, w: 10, h: 0.8, fontFace: BODY, fontSize: 20, color: fg, transparency: 20, margin: 0 })
        break
      }
      case 'bullets': {
        title(s.title ?? '')
        const img = s.image && existsSync(s.image) ? s.image : ''
        bullets(s.bullets ?? [], MX, 1.85, img ? 6.4 : W - 2 * MX, 4.9)
        if (img) {
          if (s.fit === 'contain') slide.addImage({ path: img, ...contain(img, 7.4, 1.85, 5.2, 4.75) })
          else slide.addImage({ path: img, x: 7.6, y: 1.85, w: 5.0, h: 4.75, sizing: { type: 'cover', w: 5.0, h: 4.75 } })
          if (s.credit) slide.addText(s.credit, { x: 7.4, y: 6.62, w: 5.2, h: 0.25, fontFace: BODY, fontSize: 8, color: P.muted, align: 'right', margin: 0 })
        }
        break
      }
      case 'two_column': {
        title(s.title ?? '')
        const cw = (W - 2 * MX - 0.4) / 2
        ;[s.left, s.right].forEach((col, k) => {
          const x = MX + k * (cw + 0.4)
          slide.addShape(pptx.ShapeType.roundRect, { x, y: 1.85, w: cw, h: 4.85, fill: { color: P.surface }, line: { color: P.surface }, rectRadius: 0.12 })
          slide.addShape(pptx.ShapeType.rect, { x, y: 1.85, w: 0.08, h: 4.85, fill: { color: k ? P.accent2 : P.accent }, line: { color: k ? P.accent2 : P.accent } })
          if (col?.title) slide.addText(col.title, { x: x + 0.35, y: 2.05, w: cw - 0.6, h: 0.6, fontFace: HEAD, fontSize: 22, bold: true, color: k ? P.accent2 : P.accent, margin: 0 })
          bullets(col?.bullets ?? [], x + 0.35, col?.title ? 2.8 : 2.1, cw - 0.6, col?.title ? 3.7 : 4.4, 24)
        })
        break
      }
      case 'stats': {
        title(s.title ?? '')
        const st = (s.stats ?? []).slice(0, 4)
        const gap = 0.35
        const cw = (W - 2 * MX - gap * (st.length - 1)) / Math.max(1, st.length)
        st.forEach((x, k) => {
          const cx = MX + k * (cw + gap)
          slide.addShape(pptx.ShapeType.roundRect, { x: cx, y: 2.3, w: cw, h: 3.4, fill: { color: P.surface }, line: { color: P.surface }, rectRadius: 0.14 })
          slide.addText(x.value, { x: cx + 0.2, y: 2.6, w: cw - 0.4, h: 1.5, fontFace: HEAD, fontSize: Math.max(22, Math.min(54, Math.floor(((cw - 0.4) * 72) / (0.6 * Math.max(1, x.value.length))))), bold: true, color: k % 2 ? P.accent2 : P.accent, align: 'center', valign: 'middle', margin: 0 })
          slide.addText(x.label, { x: cx + 0.25, y: 4.15, w: cw - 0.5, h: 1.3, fontFace: BODY, fontSize: 16, color: P.muted, align: 'center', valign: 'top', margin: 0 })
        })
        if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 6.0, w: W - 2 * MX, h: 0.5, fontFace: BODY, fontSize: 14, color: P.muted, italic: true, margin: 0 })
        break
      }
      case 'quote': {
        slide.addText('“', { x: MX, y: 0.5, w: 2, h: 2, fontFace: 'Georgia', fontSize: 160, color: P.accent, margin: 0 })
        slide.addText(s.quote ?? s.title ?? '', { x: 1.6, y: 2.0, w: W - 3.2, h: 3.0, fontFace: 'Georgia', fontSize: (s.quote ?? '').length > 160 ? 24 : 32, italic: true, color: P.text, align: 'center', valign: 'middle', margin: 0 })
        if (s.author) slide.addText('— ' + s.author, { x: 1.6, y: 5.2, w: W - 3.2, h: 0.6, fontFace: BODY, fontSize: 18, color: P.muted, align: 'center', margin: 0 })
        break
      }
      case 'image': {
        if (s.image && existsSync(s.image)) slide.addImage({ path: s.image, x: 0, y: 0, w: W, h: H, sizing: { type: 'cover', w: W, h: H } })
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 1.9, w: W, h: 1.9, fill: { color: '000000', transparency: 35 }, line: { color: '000000', transparency: 100 } })
        slide.addText(s.title ?? '', { x: MX, y: H - 1.75, w: W - 2 * MX, h: 0.9, fontFace: HEAD, fontSize: 32, bold: true, color: 'FFFFFF', margin: 0 })
        if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: H - 0.9, w: W - 2 * MX, h: 0.5, fontFace: BODY, fontSize: 16, color: 'E5E7EB', margin: 0 })
        if (s.credit) slide.addText(s.credit, { x: W - 5.2, y: H - 0.32, w: 5, h: 0.25, fontFace: BODY, fontSize: 8, color: 'C7CDD6', align: 'right', margin: 0 })
        break
      }
      case 'diagram': {
        title(s.title ?? '')
        const img = s.image && existsSync(s.image) ? s.image : ''
        const h = s.caption ? 4.35 : 4.85
        if (img) slide.addImage({ path: img, ...contain(img, MX, 1.8, W - 2 * MX, h) })
        if (s.caption) slide.addText(s.caption, { x: MX, y: 1.8 + h + 0.12, w: W - 2 * MX, h: 0.45, fontFace: BODY, fontSize: 14, color: P.muted, align: 'center', margin: 0 })
        if (s.credit) slide.addText(s.credit, { x: W - MX - 5, y: H - 0.8, w: 5, h: 0.25, fontFace: BODY, fontSize: 8, color: P.muted, align: 'right', margin: 0 })
        break
      }
      case 'table': {
        title(s.title ?? '')
        const rows = [...(s.header ? [s.header] : []), ...(s.rows ?? [])]
        const n = rows.length
        const fs = n > 10 ? 12 : n > 7 ? 14 : n > 4 ? 16 : 18
        slide.addTable(
          rows.map((r, ri) =>
            r.map((c) => ({
              text: c,
              options: {
                bold: !!s.header && ri === 0,
                color: s.header && ri === 0 ? (P.dark ? P.bg : 'FFFFFF') : P.text,
                fill: { color: s.header && ri === 0 ? P.accent : ri % 2 ? P.surface : P.bg }
              }
            }))
          ),
          { x: MX, y: 1.9, w: W - 2 * MX, fontFace: BODY, fontSize: fs, border: { type: 'solid', pt: 0.5, color: P.dark ? '2A3550' : 'D5DCE6' }, margin: 0.08, autoPage: false }
        )
        break
      }
      case 'timeline': {
        title(s.title ?? '')
        const st = (s.steps ?? []).slice(0, 6)
        const y = 3.3
        slide.addShape(pptx.ShapeType.line, { x: MX + 0.2, y, w: W - 2 * MX - 0.4, h: 0, line: { color: P.muted, width: 2 } })
        const step = (W - 2 * MX) / Math.max(1, st.length)
        st.forEach((x, k) => {
          const cx = MX + k * step + step / 2
          slide.addShape(pptx.ShapeType.ellipse, { x: cx - 0.22, y: y - 0.22, w: 0.44, h: 0.44, fill: { color: k % 2 ? P.accent2 : P.accent }, line: { color: P.bg, width: 3 } })
          slide.addText(x.title, { x: cx - step / 2 + 0.1, y: y + 0.45, w: step - 0.2, h: 0.7, fontFace: HEAD, fontSize: 20, bold: true, color: P.text, align: 'center', valign: 'top', margin: 0 })
          if (x.text) slide.addText(x.text, { x: cx - step / 2 + 0.1, y: y + 1.15, w: step - 0.2, h: 1.9, fontFace: BODY, fontSize: 15, color: P.muted, align: 'center', valign: 'top', margin: 0 })
        })
        break
      }
      case 'closing': {
        slide.addShape(pptx.ShapeType.ellipse, { x: -2, y: 3.2, w: 7, h: 7, fill: { color: P.accent, transparency: 85 }, line: { color: P.accent, transparency: 100 } })
        slide.addText(s.title ?? (ru ? 'Спасибо за внимание!' : 'Thank you!'), { x: MX, y: 2.4, w: W - 2 * MX, h: 1.4, fontFace: HEAD, fontSize: 48, bold: true, color: P.text, align: 'center', margin: 0 })
        if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: 3.9, w: W - 2 * MX, h: 0.8, fontFace: BODY, fontSize: 20, color: P.muted, align: 'center', margin: 0 })
        break
      }
    }
    if (s.notes) slide.addNotes(s.notes)
  })
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
}
