// Synthesises the promo voice-over with the Russian Jarvis voice on Fish Audio.
// The API key is read from the local Jarvis settings (never written anywhere): node promo/make-voice.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// node promo/make-voice.mjs [script.json] [outDir]
const out = join(here, 'build', process.argv[3] || 'voice')
mkdirSync(out, { recursive: true })

const settings = JSON.parse(readFileSync(join(process.env.APPDATA, 'Jarvis', 'settings.json'), 'utf8'))
const key = settings.fishApiKey
const voice = settings.fishVoiceRu || '680d74fbef69419f87cfc70f092a1451'
if (!key) throw new Error('Fish API key is not set in Jarvis settings')

export const LINES = JSON.parse(readFileSync(join(here, process.argv[2] || 'script.json'), 'utf8')).lines

for (const l of LINES) {
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: settings.fishModel || 's2.1-pro-free' },
    body: JSON.stringify({ text: l.say, reference_id: voice, format: 'wav', sample_rate: 44100, latency: 'normal', normalize: true, language: 'ru', prosody: { speed: l.speed ?? 1.04, normalize_loudness: true } })
  })
  if (!res.ok) throw new Error(`line ${l.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  writeFileSync(join(out, `${l.id}.wav`), Buffer.from(await res.arrayBuffer()))
  console.log('ok', l.id)
}
