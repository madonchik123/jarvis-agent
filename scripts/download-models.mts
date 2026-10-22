import { join } from 'path'
import { listAssets, installAsset } from '../src/main/models.ts'

const base = process.env.JARVIS_DATA || join(process.env.APPDATA || '', 'Jarvis')
const want = process.argv.slice(2)
const assets = listAssets(base).filter((a) => (want.length ? want.includes(a.id) : a.required) && !a.installed)
console.log('data dir:', base)
for (const a of assets) {
  let last = 0
  console.log('>>', a.id, `(${a.sizeMB}MB)`)
  await installAsset(base, a.id, (p) => {
    const now = Date.now()
    if (p.phase !== 'downloading' || now - last > 4000) {
      last = now
      console.log('  ', p.phase, p.total ? Math.round((p.received / p.total) * 100) + '%' : '', p.error || '')
    }
  })
}
console.log('done')
