// Gathers timeline + clip metadata for compose.html (promo/build/data.js)
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const b = join(here, 'build')
const tl = JSON.parse(readFileSync(join(b, 'timeline.json'), 'utf8'))
const clips = JSON.parse(readFileSync(join(b, 'clips', 'info.json'), 'utf8'))
const rects = JSON.parse(readFileSync(join(b, 'footage', 'calc_rects.json'), 'utf8'))
const front = rects.rects.find((r) => r.focused) ?? rects.rects[0]

const data = {
  total: tl.total,
  lines: tl.lines,
  clips: Object.fromEntries(Object.entries(clips).map(([k, v]) => [k, { frames: v.frames }])),
  calc: {
    w: clips.calc_desktop.w,
    // the chat clip starts ~1.5 s after the desktop recording was started (new thread + page switch + 1.2 s idle are inside the clip)
    offset: +(rects.chatStartMs / 1000 + 1.5).toFixed(2),
    firstFront: +(front.t / 1000 - 0.3).toFixed(2)
  }
}
writeFileSync(join(b, 'data.js'), 'window.PROMO = ' + JSON.stringify(data))
console.log(JSON.stringify(data.calc), data.total)
