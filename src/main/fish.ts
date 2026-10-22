/** Fish Audio cloud TTS (https://docs.fish.audio). Voices are referenced by `reference_id`; the model goes in a header. */
export interface FishConfig {
  apiKey: string
  model: string
  voiceRu: string
  voiceEn: string
}

export class FishError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

export async function fishSynth(cfg: FishConfig, text: string, lang: 'ru' | 'en', speed = 1): Promise<Buffer> {
  const ref = lang === 'ru' ? cfg.voiceRu : cfg.voiceEn
  if (!cfg.apiKey) throw new FishError('Fish Audio API key is not set')
  if (!ref) throw new FishError(`Fish Audio voice id for ${lang.toUpperCase()} is not set`)
  const body = JSON.stringify({
    text,
    reference_id: ref,
    format: 'wav',
    sample_rate: 24000,
    latency: 'balanced',
    normalize: true,
    language: lang,
    prosody: { speed: Math.min(2, Math.max(0.5, speed)), normalize_loudness: true }
  })
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json', model: cfg.model || 's2.1-pro-free' },
        body,
        signal: AbortSignal.timeout(25_000)
      })
      if (!res.ok) {
        let detail = ''
        try {
          const j: any = await res.json()
          detail = j.message || j.reason || ''
        } catch {}
        const msg = res.status === 401 ? 'invalid API key' : res.status === 402 ? 'out of credits / payment required' : res.status === 503 ? 'service busy' : detail || `HTTP ${res.status}`
        if (res.status === 503 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 500))
          lastErr = new FishError(msg, res.status)
          continue
        }
        throw new FishError(`Fish Audio: ${msg}`, res.status)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 64 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new FishError('Fish Audio returned unexpected data')
      return buf
    } catch (e: any) {
      if (e instanceof FishError) throw e
      lastErr = e
      if (attempt === 1) break
    }
  }
  throw new FishError(`Fish Audio: ${lastErr?.message || 'request failed'}`)
}
