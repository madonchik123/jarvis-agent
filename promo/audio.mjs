// Mixes the promo soundtrack: Jarvis voice lines (Fish Audio) + a generated synth bed + whoosh transitions.
// Also writes build/timeline.json (when every line starts) which the video composer uses for its scene timing.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, 'build')
const lines = JSON.parse(readFileSync(join(here, 'script.json'), 'utf8')).lines

const dur = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
const GAP = [0.35, 0.45, 0.4, 0.45, 0.4, 0.4, 0.45]
let t = 0.35
const tl = lines.map((l, i) => {
  const d = dur(join(build, 'voice', `${l.id}.wav`))
  const start = t
  t += d + (GAP[i + 1] ?? 0.4)
  return { id: l.id, say: l.say, start: +start.toFixed(3), dur: +d.toFixed(3), end: +(start + d).toFixed(3) }
})
const total = +(tl[tl.length - 1].end + 1.0).toFixed(2)
writeFileSync(join(build, 'timeline.json'), JSON.stringify({ total, lines: tl }, null, 1))
console.log('total', total, 'sec')

// scene cuts = just before each voice line (the first scene starts at 0)
const cuts = tl.slice(1).map((l) => Math.max(0, l.start - 0.12))

const args = ['-v', 'error', '-y']
tl.forEach((l) => args.push('-i', join(build, 'voice', `${l.id}.wav`)))
// music bed: dark pad (A minor-ish) + soft pulse
const pad = `aevalsrc='0.16*sin(2*PI*55*t)+0.12*sin(2*PI*82.41*t)+0.09*sin(2*PI*110*t+0.5*sin(2*PI*0.2*t))+0.06*sin(2*PI*164.81*t)+0.045*sin(2*PI*220*t*(1+0.002*sin(2*PI*0.3*t)))':d=${total}:s=44100`
const pulse = `aevalsrc='0.55*sin(2*PI*(48+60*exp(-18*mod(t,1)))*mod(t,1))*exp(-7*mod(t,1))':d=${total}:s=44100`
args.push('-f', 'lavfi', '-i', pad, '-f', 'lavfi', '-i', pulse)
cuts.forEach(() => args.push('-f', 'lavfi', '-i', 'anoisesrc=d=0.7:c=pink:a=0.5'))

const f = []
tl.forEach((l, i) => f.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(l.start * 1000)}|${Math.round(l.start * 1000)},volume=1.5[v${i}]`))
const n = tl.length
f.push(`[${n}:a]aformat=channel_layouts=stereo,lowpass=f=900,volume=0.55,afade=t=in:d=1.2,afade=t=out:st=${total - 1.5}:d=1.5[pad]`)
f.push(`[${n + 1}:a]aformat=channel_layouts=stereo,lowpass=f=140,volume=0.5,afade=t=in:d=1.5,afade=t=out:st=${total - 1.2}:d=1.2[pls]`)
cuts.forEach((c, i) => {
  const ms = Math.round(c * 1000)
  f.push(`[${n + 2 + i}:a]aformat=channel_layouts=stereo,highpass=f=500,lowpass=f=7000,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.4,volume=0.28,adelay=${Math.max(0, ms - 250)}|${Math.max(0, ms - 250)}[w${i}]`)
})
const mixIn = [...tl.map((_, i) => `[v${i}]`), '[pad]', '[pls]', ...cuts.map((_, i) => `[w${i}]`)]
f.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:${total}[out]`)
args.push('-filter_complex', f.join(';'), '-map', '[out]', '-ar', '44100', join(build, 'audio.wav'))
execFileSync('ffmpeg', args, { stdio: 'inherit' })
console.log('audio.wav ok')
