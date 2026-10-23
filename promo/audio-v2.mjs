// v2 soundtrack: Jarvis voice lines + a generated 120 bpm beat (kick, hats, sub bass) + whooshes on cuts.
// Writes build/v2/timeline.json (line starts = scene cuts) and build/v2/audio.wav.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const b = join(here, 'build')
const out = join(b, 'v2')
mkdirSync(out, { recursive: true })
const lines = JSON.parse(readFileSync(join(here, 'script-v2.json'), 'utf8')).lines
const dur = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())

// pause after each line: the task scenes get extra room so the real footage can breathe
const AFTER = [0.35, 1.5, 1.2, 1.1, 0.45, 1.4]
let t = 0.2
const tl = lines.map((l, i) => {
  const d = dur(join(b, 'voice-v2', `${l.id}.wav`))
  const start = t
  t += d + AFTER[i]
  return { id: l.id, say: l.say, start: +start.toFixed(3), dur: +d.toFixed(3), end: +(start + d).toFixed(3) }
})
const total = +t.toFixed(2)
writeFileSync(join(out, 'timeline.json'), JSON.stringify({ total, lines: tl }, null, 1))
console.log('total', total)

const cuts = tl.slice(1).map((l) => Math.max(0, l.start - 0.15))
const args = ['-v', 'error', '-y']
tl.forEach((l) => args.push('-i', join(b, 'voice-v2', `${l.id}.wav`)))
const B = 0.5 // seconds per beat (120 bpm)
const kick = `aevalsrc='0.9*sin(2*PI*(45+90*exp(-25*mod(t,${B})))*mod(t,${B}))*exp(-9*mod(t,${B}))':d=${total}:s=44100`
const sub = `aevalsrc='0.22*sin(2*PI*55*t)*(0.6+0.4*exp(-4*mod(t,${B})))+0.12*sin(2*PI*82.41*t)*(mod(floor(t/2),2))':d=${total}:s=44100`
const pad = `aevalsrc='0.07*sin(2*PI*220*t*(1+0.002*sin(2*PI*0.3*t)))+0.05*sin(2*PI*329.63*t)+0.04*sin(2*PI*440*t+sin(2*PI*0.25*t))':d=${total}:s=44100`
args.push('-f', 'lavfi', '-i', kick, '-f', 'lavfi', '-i', sub, '-f', 'lavfi', '-i', pad, '-f', 'lavfi', '-i', `anoisesrc=d=${total}:c=white:a=0.5`)
cuts.forEach(() => args.push('-f', 'lavfi', '-i', 'anoisesrc=d=0.6:c=pink:a=0.6'))

const n = tl.length
const f = []
tl.forEach((l, i) => f.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(l.start * 1000)}|${Math.round(l.start * 1000)},volume=1.6[v${i}]`))
// music ducks under the voice (sidechain), fades in fast (motion in the first second) and out at the end
f.push(`[${n}:a]aformat=channel_layouts=stereo,lowpass=f=180,volume=0.55[k]`)
f.push(`[${n + 1}:a]aformat=channel_layouts=stereo,lowpass=f=220,volume=0.8[s]`)
f.push(`[${n + 2}:a]aformat=channel_layouts=stereo,lowpass=f=2400,volume=0.6[p]`)
// off-beat hats: white noise gated to 40 ms on every half beat
f.push(`[${n + 3}:a]aformat=channel_layouts=stereo,highpass=f=7000,volume='if(lt(mod(t-${B / 2},${B}),0.04),0.18,0)':eval=frame[h]`)
f.push(`[k][s][p][h]amix=inputs=4:normalize=0,afade=t=in:d=0.4,afade=t=out:st=${total - 1.6}:d=1.6[music]`)
const voice = tl.map((_, i) => `[v${i}]`).join('')
f.push(`${voice}amix=inputs=${n}:normalize=0,apad=whole_dur=${total},asplit=2[vo][sc]`)
f.push(`[music][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[duck]`)
cuts.forEach((c, i) => {
  const ms = Math.max(0, Math.round(c * 1000) - 220)
  f.push(`[${n + 4 + i}:a]aformat=channel_layouts=stereo,highpass=f=600,lowpass=f=8000,afade=t=in:d=0.22,afade=t=out:st=0.25:d=0.35,volume=0.3,adelay=${ms}|${ms}[w${i}]`)
})
const mix = ['[vo]', '[duck]', ...cuts.map((_, i) => `[w${i}]`)]
f.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:${total}[out]`)
args.push('-filter_complex', f.join(';'), '-map', '[out]', '-ar', '44100', join(out, 'audio.wav'))
execFileSync('ffmpeg', args, { stdio: 'inherit' })
console.log('audio ok')
