// Fuzzy text helpers shared by the wake-word detector and the routine matcher.
// Pure functions — no Node/Electron APIs — so they can run in the speech worker too.

const TRANSLIT: [RegExp, string][] = [
  [/dzh|j(?=[aeiouy])/g, 'дж'],
  [/sh/g, 'ш'],
  [/ch/g, 'ч'],
  [/ts/g, 'ц'],
  [/ph/g, 'ф'],
  [/th/g, 'т'],
  [/ee/g, 'и'],
  [/oo/g, 'у'],
  [/a/g, 'а'],
  [/b/g, 'б'],
  [/c/g, 'к'],
  [/d/g, 'д'],
  [/e/g, 'е'],
  [/f/g, 'ф'],
  [/g/g, 'г'],
  [/h/g, 'х'],
  [/i/g, 'и'],
  [/j/g, 'дж'],
  [/k/g, 'к'],
  [/l/g, 'л'],
  [/m/g, 'м'],
  [/n/g, 'н'],
  [/o/g, 'о'],
  [/p/g, 'п'],
  [/q/g, 'к'],
  [/r/g, 'р'],
  [/s/g, 'с'],
  [/t/g, 'т'],
  [/u/g, 'у'],
  [/v/g, 'в'],
  [/w/g, 'в'],
  [/x/g, 'кс'],
  [/y/g, 'и'],
  [/z/g, 'з']
]

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function translitToCyrillic(s: string): string {
  let out = normalize(s)
  for (const [re, to] of TRANSLIT) out = out.replace(re, to)
  return out
}

/** Collapse near-identical sounds so Russian ASR variants ("жарвис"/"джарвис"/"ярвис") compare as close. */
function phonetic(s: string): string {
  return translitToCyrillic(s)
    .replace(/^(дж|ч|д|г|я)(?=[аеиоуэяы])/, 'ж')
    .replace(/дж/g, 'ж')
    .replace(/[ъь]/g, '')
    .replace(/з/g, 'с')
    .replace(/[иы]/g, 'ы')
    .replace(/[еэя]/g, 'а')
    .replace(/(.)\1+/g, '$1')
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export function similarity(a: string, b: string): number {
  const pa = phonetic(a)
  const pb = phonetic(b)
  const max = Math.max(pa.length, pb.length)
  if (!max) return 1
  return 1 - levenshtein(pa, pb) / max
}

export interface WakeHit {
  /** number of tokens (from the start of the text) consumed by the wake phrase and optional greeting */
  consumed: number
  alias: string
  score: number
}

const GREETINGS = new Set(['эй', 'хей', 'hey', 'ok', 'окей', 'ладно', 'привет', 'слушай', 'йо'])

/**
 * Looks for a wake alias within the first few tokens of `text`.
 * sensitivity 0..1 — higher accepts looser matches.
 */
export function wakeThreshold(sensitivity: number) {
  return 1.0 - sensitivity * 0.2 // 0.6 -> 0.88
}

export function findWake(text: string, aliases: string[], sensitivity = 0.6, maxLead = 4, thresholdOverride?: number): WakeHit | null {
  const tokens = normalize(text).split(' ').filter(Boolean)
  if (!tokens.length) return null
  const threshold = thresholdOverride ?? wakeThreshold(sensitivity)
  const onsetOk = (cand: string, alias: string, score: number) => score >= 0.9 || phonetic(cand)[0] === phonetic(alias)[0]
  let best: WakeHit | null = null
  for (const alias of aliases) {
    const aTokens = normalize(alias).split(' ').filter(Boolean)
    if (!aTokens.length) continue
    for (let i = 0; i < Math.min(tokens.length, maxLead); i++) {
      if (i + aTokens.length > tokens.length) break
      const cand = tokens.slice(i, i + aTokens.length).join(' ')
      let score = similarity(cand, aTokens.join(' '))
      // the recogniser sometimes glues the wake word to the next word or splits it ("джар вис")
      if (aTokens.length === 1 && i + 1 < tokens.length) {
        const ms = similarity(tokens[i] + tokens[i + 1], aTokens[0])
        if (ms >= threshold && ms > score && ms > (best?.score ?? 0) && onsetOk(tokens[i] + tokens[i + 1], aliases[0] ? aTokens[0] : '', ms)) {
          best = { consumed: i + 2, alias, score: ms }
          continue
        }
      }
      if (score >= threshold && score > (best?.score ?? 0) && onsetOk(cand, aTokens.join(' '), score)) {
        best = { consumed: i + aTokens.length, alias, score }
      }
    }
  }
  return best
}

/** Removes the wake phrase (+ leading greeting) from a transcript, returns the remaining command. */
export function stripWake(text: string, aliases: string[], sensitivity = 0.6, thresholdOverride?: number): { command: string; hit: WakeHit | null } {
  const hit = findWake(text, aliases, sensitivity, 4, thresholdOverride)
  if (!hit) return { command: text.trim(), hit: null }
  const raw = text.trim().split(/\s+/)
  let rest = raw.slice(hit.consumed)
  // drop a trailing separator glued to the wake word, e.g. "Jarvis," already removed by token split
  while (rest.length && /^[,.:;!?-]+$/.test(rest[0])) rest = rest.slice(1)
  const cmd = rest.join(' ').replace(/^[,.:;!?\s-]+/, '').trim()
  return { command: cmd, hit }
}

export function isGreeting(tok: string) {
  return GREETINGS.has(tok)
}

/** Match a spoken command against a routine trigger phrase. Returns similarity 0..1. */
export function phraseScore(spoken: string, trigger: string): number {
  const a = normalize(spoken)
  const b = normalize(trigger)
  if (!a || !b) return 0
  if (a === b) return 1
  const max = Math.max(a.length, b.length)
  return 1 - levenshtein(a, b) / max
}

/**
 * Very forgiving first-stage check used on the (weak, Russian-only) streaming recogniser.
 * It only decides whether Whisper should take a second, authoritative look at the utterance.
 */
export function looseWakeGate(text: string, aliases: string[]): boolean {
  const tokens = normalize(text).split(' ').filter(Boolean).slice(0, 3)
  for (const t of tokens) {
    for (const a of aliases) {
      if (t.length >= 4 && similarity(t, a) >= 0.6) return true
    }
    // "ча", "чав", "джав", "жарв" ... : sibilant onset + v
    if (/^(дж|ж|ч|я|д)[аеиуояы]?[рв]/.test(t) && t.length <= 8) return true
  }
  return false
}
