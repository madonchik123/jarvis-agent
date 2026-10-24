// v3 soundtrack: narration (Jarvis voice), the spoken question (another voice), Jarvis' real replies — each placed at an
// explicit time — over the 120 bpm bed with ducking and whooshes on cuts. Writes build/v3/audio.wav + timeline.json.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const vdir = join(here, 'build', 'voice-v3')
const out = join(here, 'build', 'v3')
mkdirSync(out, { recursive: true })
const dur = (f) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())

// when each clip starts (s); the edit in compose-v3.html is built around these
export const PLACE = [
  { id: 'n1', at: 0.25, who: 'jarvis', say: 'Хотите своего Джарвиса? Это займёт одну минуту.' },
  { id: 'n2', at: 4.55, who: 'jarvis', say: 'Скачайте установщик — ссылка в профиле.' },
  { id: 'n3', at: 7.45, who: 'jarvis', say: 'Одна кнопка, и всё ставится само.' },
  { id: 'n4', at: 13.35, who: 'jarvis', say: 'А дальше — просто говорите.' },
  { id: 'user', at: 15.3, who: 'user', say: 'Джарвис, какой сейчас курс доллара к рублю?' },
  { id: 'a1', at: 19.3, who: 'jarvis', say: 'Одну секунду, сэр, уточняю курс.' },
  { id: 'a2', at: 22.45, who: 'jarvis', say: 'Официальный курс ЦБ на сегодня — 80 рублей 54 копейки за доллар, сэр. За день рубль укрепился почти на 59 копеек.' },
  { id: 'n5', at: 31.8, who: 'jarvis', say: 'Бесплатно, без ключей и регистрации. Ссылка в профиле.' }
]
const lines = PLACE.map((p) => ({ ...p, dur: +dur(join(vdir, `${p.id}.wav`)).toFixed(3) })).map((p) => ({ ...p, end: +(p.at + p.dur).toFixed(3) }))
const total = +(lines[lines.length - 1].end + 1.1).toFixed(2)
const cuts = [4.4, 7.3, 13.2, 31.6]
writeFileSync(join(out, 'timeline.json'), JSON.stringify({ total, cuts, lines }, null, 1))
console.log('total', total)

const args = ['-v', 'error', '-y']
lines.forEach((l) => args.push('-i', join(vdir, `${l.id}.wav`)))
const B = 0.5
args.push('-f', 'lavfi', '-i', `aevalsrc='0.9*sin(2*PI*(45+90*exp(-25*mod(t,${B})))*mod(t,${B}))*exp(-9*mod(t,${B}))':d=${total}:s=44100`)
args.push('-f', 'lavfi', '-i', `aevalsrc='0.22*sin(2*PI*55*t)*(0.6+0.4*exp(-4*mod(t,${B})))+0.12*sin(2*PI*82.41*t)*(mod(floor(t/2),2))':d=${total}:s=44100`)
args.push('-f', 'lavfi', '-i', `aevalsrc='0.07*sin(2*PI*220*t*(1+0.002*sin(2*PI*0.3*t)))+0.05*sin(2*PI*329.63*t)+0.04*sin(2*PI*440*t+sin(2*PI*0.25*t))':d=${total}:s=44100`)
args.push('-f', 'lavfi', '-i', `anoisesrc=d=${total}:c=white:a=0.5`)
cuts.forEach(() => args.push('-f', 'lavfi', '-i', 'anoisesrc=d=0.6:c=pink:a=0.6'))
const n = lines.length
const f = []
lines.forEach((l, i) => {
  const ms = Math.round(l.at * 1000)
  // the person asking sounds a touch further away than Jarvis
  const color = l.who === 'user' ? 'highpass=f=120,lowpass=f=7500,volume=1.25' : 'volume=1.6'
  f.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,${color},adelay=${ms}|${ms}[v${i}]`)
})
f.push(`[${n}:a]aformat=channel_layouts=stereo,lowpass=f=180,volume=0.5[k]`)
f.push(`[${n + 1}:a]aformat=channel_layouts=stereo,lowpass=f=220,volume=0.75[s]`)
f.push(`[${n + 2}:a]aformat=channel_layouts=stereo,lowpass=f=2400,volume=0.55[p]`)
f.push(`[${n + 3}:a]aformat=channel_layouts=stereo,highpass=f=7000,volume='if(lt(mod(t-${B / 2},${B}),0.04),0.16,0)':eval=frame[h]`)
f.push(`[k][s][p][h]amix=inputs=4:normalize=0,afade=t=in:d=0.4,afade=t=out:st=${total - 1.6}:d=1.6[music]`)
f.push(`${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${n}:normalize=0,apad=whole_dur=${total},asplit=2[vo][sc]`)
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
