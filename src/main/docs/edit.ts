// In-place edits of existing DOCX / PPTX files that keep their formatting.
// Paragraph indexes are the [#n] numbers doc_read prints (top-level body paragraphs), always of the file as it was
// before this call, so several operations can be sent together without recounting.
import { writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { loadZip, styleNames, paragraphKind } from './read'
import { splitBody, allParagraphs, wText, aText, encode } from './xml'

export interface EditOp {
  op: 'replace_text' | 'set_paragraph' | 'insert_after' | 'delete'
  find?: string
  replace?: string
  all?: boolean
  index?: number
  count?: number
  text?: string
  blocks?: { type: 'paragraph' | 'heading' | 'bullet'; text: string; level?: number }[]
}

const pPrOf = (p: string) => /<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/.exec(p)?.[0] ?? ''
const rPrOf = (p: string) => /<w:r(?:\s[^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(p)?.[1] ?? ''
const openTag = (p: string) => /^<w:p(?:\s[^>]*)?>/.exec(p)?.[0]?.replace(/\/>$/, '>') ?? '<w:p>'

function runXml(text: string, rPr: string) {
  const parts = text.split(/(\t|\n)/)
  const inner = parts.map((t) => (t === '\t' ? '<w:tab/>' : t === '\n' ? '<w:br/>' : t ? `<w:t xml:space="preserve">${encode(t)}</w:t>` : '')).join('')
  return `<w:r>${rPr}${inner}</w:r>`
}

/** paragraph with the same paragraph/run formatting but new text */
function rewrite(p: string, text: string) {
  return `${openTag(p)}${pPrOf(p)}${runXml(text, rPrOf(p))}</w:p>`
}

function replaceIn(p: string, find: string, rep: string, all: boolean): { xml: string; n: number } {
  const full = wText(p)
  if (!full.includes(find)) return { xml: p, n: 0 }
  // 1) the match sits inside one text node → swap it there and every run keeps its own formatting
  let n = 0
  const ef = encode(find)
  const local = p.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (m, a, t, b) => {
    if (!all && n) return m
    if (!t.includes(ef)) return m
    const parts = t.split(ef)
    const k = all ? parts.length - 1 : 1
    n += k
    return a.replace('<w:t>', '<w:t xml:space="preserve">') + (all ? parts.join(encode(rep)) : t.replace(ef, encode(rep))) + b
  })
  const occurrences = full.split(find).length - 1
  if (n >= (all ? occurrences : 1)) return { xml: local, n }
  // 2) the match spans runs → merge the paragraph into one run (keeps paragraph style and the first run's formatting)
  const k = all ? occurrences : 1
  return { xml: rewrite(p, all ? full.split(find).join(rep) : full.replace(find, rep)), n: k }
}

function backup(path: string, backupDir: string) {
  mkdirSync(backupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const b = join(backupDir, `${basename(path, extname(path))}.${ts}${extname(path)}`)
  copyFileSync(path, b)
  return b
}

export async function editDocx(path: string, ops: EditOp[], outPath: string, backupDir: string): Promise<string> {
  const zip = await loadZip(path)
  const docXml = await zip.file('word/document.xml')!.async('string')
  const styles = await styleNames(zip)
  const { head, items, tail } = splitBody(docXml)
  const paras = items.map((it, i) => ({ it, i })).filter((x) => x.it.kind === 'p')
  const at = (index: number) => {
    const p = paras[index]
    if (!p) throw new Error(`paragraph #${index} does not exist (document has ${paras.length}: read it again with doc_read)`)
    return p
  }
  const kinds = paras.map((p) => paragraphKind(p.it.xml, styles))
  const sample = (pred: (k: ReturnType<typeof paragraphKind>, t: string) => boolean) => {
    const j = paras.findIndex((p, k) => pred(kinds[k], wText(p.it.xml).trim()))
    return j >= 0 ? paras[j].it.xml : ''
  }
  const headingStyleId = (lvl: number) => [...styles.entries()].find(([, n]) => n === `heading ${lvl}`)?.[0] ?? `Heading${lvl}`
  const newPara = (b: { type: string; text: string; level?: number }, ref: string) => {
    if (b.type === 'heading') {
      const lvl = Math.min(6, Math.max(1, b.level ?? 1))
      const like = sample((k) => k.heading === lvl)
      return like ? rewrite(like, b.text) : `<w:p><w:pPr><w:pStyle w:val="${headingStyleId(lvl)}"/></w:pPr>${runXml(b.text, '')}</w:p>`
    }
    if (b.type === 'bullet') {
      const like = sample((k) => k.list)
      return like ? rewrite(like, b.text) : rewrite(ref || '<w:p></w:p>', '• ' + b.text)
    }
    const k = ref ? paragraphKind(ref, styles) : null
    const like = ref && k && !k.heading && !k.list && wText(ref).trim() ? ref : sample((kk, t) => !kk.heading && !kk.list && t.length > 40)
    return like ? rewrite(like, b.text) : `<w:p>${runXml(b.text, '')}</w:p>`
  }

  const out = items.map((it) => it.xml)
  const after = new Map<number, string[]>() // item position → paragraphs inserted after it
  const done: string[] = []
  let replaced = 0
  for (const o of ops) {
    if (o.op === 'set_paragraph') {
      const p = at(o.index ?? -1)
      out[p.i] = rewrite(p.it.xml, o.text ?? '')
      done.push(`set #${o.index}`)
    } else if (o.op === 'delete') {
      for (let k = 0; k < Math.max(1, o.count ?? 1); k++) out[at((o.index ?? -1) + k).i] = ''
      done.push(`deleted #${o.index}${(o.count ?? 1) > 1 ? `…#${(o.index ?? 0) + (o.count ?? 1) - 1}` : ''}`)
    } else if (o.op === 'insert_after') {
      const idx = o.index ?? paras.length - 1
      const pos = idx < 0 ? -1 : at(idx).i
      const ref = idx < 0 ? paras[0]?.it.xml ?? '' : at(idx).it.xml
      const list = after.get(pos) ?? []
      list.push(...(o.blocks ?? (o.text ? [{ type: 'paragraph' as const, text: o.text }] : [])).map((b) => newPara(b, ref)))
      after.set(pos, list)
      done.push(`inserted ${o.blocks?.length ?? 1} after #${idx}`)
    }
  }
  let body = (after.get(-1) ?? []).join('') + out.map((x, i) => x + (after.get(i) ?? []).join('')).join('')
  for (const o of ops.filter((x) => x.op === 'replace_text')) {
    if (!o.find) continue
    let n = 0
    let rebuilt = ''
    let last = 0
    for (const p of allParagraphs(body)) {
      rebuilt += body.slice(last, p.start)
      last = p.end
      if (!o.all && n) {
        rebuilt += p.xml
        continue
      }
      const r = replaceIn(p.xml, o.find, o.replace ?? '', !!o.all)
      n += r.n
      rebuilt += r.xml
    }
    body = rebuilt + body.slice(last)
    replaced += n
    done.push(`replaced "${o.find.slice(0, 40)}" ×${n}`)
  }
  zip.file('word/document.xml', head + body + tail)
  const bak = outPath === path ? backup(path, backupDir) : ''
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return `${done.join('; ') || 'no changes'} → ${outPath}${bak ? ` (backup: ${bak})` : ''}${ops.some((o) => o.op === 'replace_text') && !replaced ? '\nwarning: replace_text found nothing — check the exact wording with doc_read' : ''}`
}

/** PPTX: text replacement across all slides (and notes); for new or rearranged slides rebuild the deck with slides_create */
export async function editPptx(path: string, ops: EditOp[], outPath: string, backupDir: string): Promise<string> {
  const zip = await loadZip(path)
  const files = Object.keys(zip.files).filter((f) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(f))
  const done: string[] = []
  for (const o of ops) {
    if (o.op !== 'replace_text' || !o.find) throw new Error('PPTX supports only replace_text here; to change slides themselves, read the deck and rebuild it with slides_create')
    let n = 0
    for (const f of files) {
      let xml = await zip.file(f)!.async('string')
      const before = xml
      xml = xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (p) => {
        if (!o.all && n) return p
        const full = aText(p)
        if (!full.includes(o.find!)) return p
        const ef = encode(o.find!)
        let local = 0
        const swapped = p.replace(/(<a:t>)([\s\S]*?)(<\/a:t>)/g, (m, a, t, b) => {
          if ((!o.all && local) || !t.includes(ef)) return m
          local += o.all ? t.split(ef).length - 1 : 1
          return a + (o.all ? t.split(ef).join(encode(o.replace ?? '')) : t.replace(ef, encode(o.replace ?? ''))) + b
        })
        if (local) {
          n += local
          return swapped
        }
        // spans runs: keep the first run's properties
        const rPr = /<a:rPr[^>]*\/>|<a:rPr[^>]*>[\s\S]*?<\/a:rPr>/.exec(p)?.[0] ?? ''
        const pPr = /<a:pPr[^>]*\/>|<a:pPr[^>]*>[\s\S]*?<\/a:pPr>/.exec(p)?.[0] ?? ''
        n += 1
        return `<a:p>${pPr}<a:r>${rPr}<a:t>${encode(o.all ? full.split(o.find!).join(o.replace ?? '') : full.replace(o.find!, o.replace ?? ''))}</a:t></a:r></a:p>`
      })
      if (xml !== before) zip.file(f, xml)
    }
    done.push(`replaced "${o.find.slice(0, 40)}" ×${n}`)
  }
  const bak = outPath === path ? backup(path, backupDir) : ''
  writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return `${done.join('; ')} → ${outPath}${bak ? ` (backup: ${bak})` : ''}`
}

export { allParagraphs }
