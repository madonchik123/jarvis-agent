// Free-licence image search for documents and slides: Wikimedia Commons (primary) and Openverse (fallback).
// Only freely licensed images (public domain / CC0 / CC BY / CC BY-SA) are returned, downloaded locally, each with a
// ready-to-use credit line, since CC BY / BY-SA require attribution.
import { net } from 'electron'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { imageSize } from './spec'

const UA = 'JarvisAssistant/1.2 (https://github.com/madonchik123/jarvis-agent)'

export interface FoundImage {
  path: string
  width: number
  height: number
  title: string
  description: string
  author: string
  license: string
  source: string
  credit: string
}

const strip = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
/** 'A / /B / C;' → 'A / B', at most ~60 chars, cut at a separator */
function cleanAuthor(a: string) {
  const parts = a.split(/\s*[/;|]\s*/).map((x) => x.trim().replace(/[,.;:]+$/, '')).filter(Boolean)
  let out = ''
  for (const x of parts) {
    if ((out + ' / ' + x).length > 60 && out) break
    out = out ? out + ' / ' + x : x
  }
  return out.slice(0, 80)
}
const FREE = /^(public domain|pd|cc0|cc[- ]by(?:[- ]sa)?(?:[- ][\d.]+)?)/i

async function getJson(url: string) {
  const r = await net.fetch(url, { headers: { 'user-agent': UA } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<any>
}

type Candidate = Omit<FoundImage, 'path' | 'width' | 'height'> & { url: string; w: number; h: number }

async function commons(query: string, limit: number): Promise<Candidate[]> {
  const u =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6' +
    `&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}&gsrlimit=${limit}&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=1600`
  const j = await getJson(u)
  const pages = Object.values(j?.query?.pages ?? {}) as any[]
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return pages
    .map((p) => {
      const i = p.imageinfo?.[0]
      const m = i?.extmetadata ?? {}
      const license = strip(m.LicenseShortName?.value) || strip(m.License?.value)
      return {
        url: i?.thumburl || i?.url,
        w: i?.thumbwidth || i?.width,
        h: i?.thumbheight || i?.height,
        title: String(p.title || '').replace(/^File:/, '').replace(/\.\w+$/, ''),
        description: strip(m.ImageDescription?.value).slice(0, 200),
        author: cleanAuthor(strip(m.Artist?.value)) || 'Wikimedia Commons',
        license,
        source: i?.descriptionurl || '',
        mime: String(i?.mime || '')
      }
    })
    .filter((c) => c.url && /^image\/(jpeg|png)$/.test(c.mime) && FREE.test(c.license))
    .map(({ mime: _m, ...c }) => ({ ...c, credit: `${c.author}, ${c.license}, Wikimedia Commons` }))
}

async function openverse(query: string, limit: number): Promise<Candidate[]> {
  const j = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${limit}&license=cc0,pdm,by,by-sa&extension=jpg,png`)
  return (j?.results ?? []).map((x: any) => {
    const license = x.license === 'pdm' ? 'Public domain' : x.license === 'cc0' ? 'CC0' : `CC ${String(x.license).toUpperCase()} ${x.license_version ?? ''}`.trim()
    return { url: x.url, w: x.width, h: x.height, title: x.title ?? '', description: '', author: x.creator || x.source || 'Openverse', license, source: x.foreign_landing_url || x.url, credit: `${x.creator || 'unknown'}, ${license}, via Openverse` }
  })
}

export async function searchImages(query: string, dir: string, o: { count?: number; orientation?: 'landscape' | 'portrait' | 'square' | 'any' } = {}): Promise<FoundImage[]> {
  const want = Math.max(1, Math.min(8, o.count ?? 4))
  let cands: Candidate[] = []
  const errors: string[] = []
  for (const src of [commons, openverse]) {
    try {
      cands.push(...(await src(query, Math.max(20, want * 5))))
    } catch (e: any) {
      errors.push(String(e?.message || e))
    }
    if (cands.length >= Math.max(10, want * 3)) break
  }
  const orient = o.orientation ?? 'any'
  const fits = (c: Candidate) => {
    const r = c.w / Math.max(1, c.h)
    if (r > 3 || r < 0.33 || Math.min(c.w, c.h) < 500) return false // panoramas, strips and thumbnails look bad on a page
    return orient === 'any' || (orient === 'landscape' ? r >= 1.15 : orient === 'portrait' ? r <= 0.87 : r > 0.87 && r < 1.15)
  }
  const usable = cands.filter((c) => { const r = c.w / Math.max(1, c.h); return r <= 3 && r >= 0.33 && Math.min(c.w, c.h) >= 500 })
  const oriented = usable.filter(fits)
  cands = oriented.length ? oriented : usable // better a portrait photo than none
  if (!cands.length) throw new Error(`no free-licence images found for "${query}"${errors.length ? ` (${errors.join('; ')})` : ''} — try a simpler English query`)
  mkdirSync(dir, { recursive: true })
  const slug = query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image'
  const out: FoundImage[] = []
  for (const c of cands) {
    if (out.length >= want) break
    try {
      const r = await net.fetch(c.url, { headers: { 'user-agent': UA } })
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      const sz = imageSize(buf)
      if (!sz || (sz.type !== 'jpg' && sz.type !== 'png')) continue
      let p = join(dir, `${slug}-${out.length + 1}.${sz.type}`)
      for (let k = 2; existsSync(p); k++) p = join(dir, `${slug}-${out.length + 1}-${k}.${sz.type}`)
      writeFileSync(p, buf)
      out.push({ path: p, width: sz.w, height: sz.h, title: c.title, description: c.description, author: c.author, license: c.license, source: c.source, credit: c.credit })
    } catch {}
  }
  if (!out.length) throw new Error('found images but could not download them (network?)')
  return out
}
