// Combines the v2 timeline, footage info and the hand-written edit (promo/edit-v2.json) into build/v2/data.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const v2 = join(here, 'build', 'v2')
const tl = JSON.parse(readFileSync(join(v2, 'timeline.json'), 'utf8'))
const info = JSON.parse(readFileSync(join(v2, 'info.json'), 'utf8'))
const edit = JSON.parse(readFileSync(join(here, 'edit-v2.json'), 'utf8'))
const orbFrames = readdirSync(join(here, 'build', 'clips', 'orb')).length
writeFileSync(join(v2, 'data.js'), 'window.PROMO2 = ' + JSON.stringify({ total: tl.total, lines: tl.lines, info, edit, orbFrames }))
console.log('data.js ok', tl.total, Object.keys(info))
