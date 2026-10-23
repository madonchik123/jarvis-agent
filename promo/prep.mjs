// Turns the raw captures (variable-rate JPEGs + desktop recording) into constant-30fps JPEG sequences in promo/build/clips.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const raw = join(here, 'build', 'footage')
const clips = join(here, 'build', 'clips')
mkdirSync(clips, { recursive: true })
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })

const info = {}
for (const name of readdirSync(raw, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(raw, d.name, 'meta.json'))).map((d) => d.name)) {
  const meta = JSON.parse(readFileSync(join(raw, name, 'meta.json'), 'utf8'))
  const lines = []
  for (let i = 0; i < meta.frames; i++) {
    const next = i + 1 < meta.frames ? meta.times[i + 1] : meta.durationMs
    lines.push(`file '${join(raw, name, `f${String(i).padStart(5, '0')}.jpg`).replace(/\\/g, '/')}'`, `duration ${Math.max(0.001, (next - meta.times[i]) / 1000).toFixed(4)}`)
  }
  lines.push(lines[lines.length - 2]) // concat demuxer quirk: repeat the last file
  const list = join(raw, name, 'list.txt')
  writeFileSync(list, lines.join('\n'))
  const out = join(clips, name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30', '-q:v', '2', join(out, '%05d.jpg')])
  const frames = readdirSync(out).length
  info[name] = { frames, seconds: +(frames / 30).toFixed(2) }
  console.log(name, info[name])
}

// the calculator window, cropped out of the desktop recording (nothing else of the desktop is ever used)
const rects = JSON.parse(readFileSync(join(raw, 'calc_rects.json'), 'utf8'))
if (rects.rects.length) {
  const med = (k) => rects.rects.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rects.rects.length / 2)]
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(med)
  const out = join(clips, 'calc_desktop')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  ff(['-i', join(raw, 'desktop.mkv'), '-vf', `crop=${w - (w % 2)}:${h - (h % 2)}:${x}:${y},fps=30`, '-q:v', '2', join(out, '%05d.jpg')])
  info.calc_desktop = { x, y, w, h, frames: readdirSync(out).length, firstSeenMs: rects.rects[0].t, chatStartMs: rects.chatStartMs }
  console.log('calc_desktop', info.calc_desktop)
}
writeFileSync(join(clips, 'info.json'), JSON.stringify(info, null, 1))
