// v3 footage prep: installer screen recording + the off-screen app capture of the spoken question → 30 fps JPEG sequences.
//   node promo/prep-v3.mjs   → promo/build/v3/{installer,ask}/00001.jpg … + info.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const raw = join(here, 'build', 'footage-v3')
const out = join(here, 'build', 'v3')
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' })
const fresh = (d) => (rmSync(d, { recursive: true, force: true }), mkdirSync(d, { recursive: true }), d)

// installer window (780 × 500), upscaled once with a good filter so the composer doesn't blur it
const inst = fresh(join(out, 'installer'))
ff(['-i', join(raw, 'installer.mkv'), '-vf', 'fps=30,scale=1000:-2:flags=lanczos', '-q:v', '2', join(inst, '%05d.jpg')])

// the app (portrait capture, variable frame rate) → constant 30 fps, top part with the orb header and the chat
const meta = JSON.parse(readFileSync(join(raw, 'ask', 'meta.json'), 'utf8'))
const lines = []
for (let i = 0; i < meta.frames; i++) {
  const next = i + 1 < meta.frames ? meta.times[i + 1] : meta.durationMs
  lines.push(`file '${join(raw, 'ask', `f${String(i).padStart(5, '0')}.jpg`).replace(/\\/g, '/')}'`, `duration ${Math.max(0.001, (next - meta.times[i]) / 1000).toFixed(4)}`)
}
lines.push(lines[lines.length - 2])
writeFileSync(join(raw, 'ask', 'list.txt'), lines.join('\n'))
const ask = fresh(join(out, 'ask'))
ff(['-f', 'concat', '-safe', '0', '-i', join(raw, 'ask', 'list.txt'), '-vf', 'fps=30,crop=1080:1500:0:0', '-q:v', '2', join(ask, '%05d.jpg')])

const info = {
  installer: { frames: readdirSync(inst).length, w: 1000, h: 642 },
  ask: { frames: readdirSync(ask).length, w: 1080, h: 1500, feedAt: meta.feedAtMs / 1000 }
}
writeFileSync(join(out, 'info.json'), JSON.stringify(info, null, 1))
console.log(JSON.stringify(info))
