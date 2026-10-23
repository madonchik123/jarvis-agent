// v2 footage prep: turns each task capture (desktop .mkv + window rects + off-screen chat JPEGs) into
// fixed-rate JPEG sequences the composer can index by time.
//   node promo/prep-v2.mjs <footageDir>      → promo/build/v2/<task>/{desk,head}/00001.jpg … + info.json
// Only the target app windows are ever cut out of the desktop recording (union of their placed rects).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const raw = resolve(process.argv[2] || join(here, 'build', 'footage3'))
const outRoot = join(here, 'build', 'v2')
const FPS = 15
mkdirSync(outRoot, { recursive: true })
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
const only = process.argv[3]?.split(',')

const info = existsSync(join(outRoot, 'info.json')) ? JSON.parse(readFileSync(join(outRoot, 'info.json'), 'utf8')) : {}
for (const task of ['t_paint', 't_calc', 't_letter']) {
  if (only && !only.includes(task)) continue
  if (!existsSync(join(raw, `${task}_rects.json`))) continue
  const { rects, stage } = JSON.parse(readFileSync(join(raw, `${task}_rects.json`), 'utf8'))
  const meta = JSON.parse(readFileSync(join(raw, task, 'meta.json'), 'utf8'))
  const dir = join(outRoot, task)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'head'), { recursive: true })

  // one sequence per app window, cropped to that window only (never the desktop around it)
  const desks = {}
  for (const kind of [...new Set(rects.map((r) => r.kind))]) {
    const big = rects.filter((r) => r.kind === kind && r.w > 380 && r.h > 380)
    if (!big.length) continue
    // clamp to the recorded stage (a maximised window reaches past it)
    const x0 = Math.max(0, Math.min(...big.map((r) => r.x))), y0 = Math.max(0, Math.min(...big.map((r) => r.y)))
    const x1 = Math.min(stage.w, Math.max(...big.map((r) => r.x + r.w))), y1 = Math.min(stage.h, Math.max(...big.map((r) => r.y + r.h)))
    const cw = (x1 - x0) & ~1, ch = (y1 - y0) & ~1
    const W = Math.min(1000, cw) & ~1, H = Math.round((ch * W) / cw / 2) * 2
    mkdirSync(join(dir, 'desk_' + kind), { recursive: true })
    ff(['-i', join(raw, `${task}.mkv`), '-vf', `crop=${cw}:${ch}:${x0}:${y0},fps=${FPS},scale=${W}:${H}:flags=lanczos`, '-q:v', '3', join(dir, 'desk_' + kind, '%05d.jpg')])
    desks[kind] = { frames: readdirSync(join(dir, 'desk_' + kind)).length, w: W, h: H, crop: [x0, y0, cw, ch], firstSeen: +(big[0].t / 1000).toFixed(2) }
  }

  // chat header (orb + state + live step) from the variable-rate off-screen capture
  const lines = []
  for (let i = 0; i < meta.frames; i++) {
    const next = i + 1 < meta.frames ? meta.times[i + 1] : meta.durationMs
    lines.push(`file '${join(raw, task, `f${String(i).padStart(5, '0')}.jpg`).replace(/\\/g, '/')}'`, `duration ${Math.max(0.001, (next - meta.times[i]) / 1000).toFixed(4)}`)
  }
  lines.push(lines[lines.length - 2])
  writeFileSync(join(raw, task, 'list.txt'), lines.join('\n'))
  ff(['-f', 'concat', '-safe', '0', '-i', join(raw, task, 'list.txt'), '-vf', `fps=${FPS},crop=1016:248:32:34`, '-q:v', '3', join(dir, 'head', '%05d.jpg')])

  info[task] = {
    fps: FPS,
    desks,
    head: { frames: readdirSync(join(dir, 'head')).length },
    // chat clip time 0 == desktop time deskOffset
    deskOffset: +(meta.deskOffsetMs / 1000).toFixed(3)
  }
  console.log(task, JSON.stringify(info[task]))
}
writeFileSync(join(outRoot, 'info.json'), JSON.stringify(info, null, 1))
