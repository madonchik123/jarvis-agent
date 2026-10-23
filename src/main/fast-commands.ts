/**
 * Instant commands that need no language model: volume, media keys, desktop. Matched on the normalised phrase, executed
 * with the native helper and answered with a short spoken confirmation — "louder" takes ~300 ms instead of an agent turn.
 */
export interface FastAction {
  kind: 'volume' | 'media' | 'desktop'
  action: string
  level?: number
  step?: number
  say: [string, string] // [ru, en]
}

const N = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// numbers spelled out in speech (the recogniser may write digits or words)
const WORDS_RU: Record<string, number> = { ноль: 0, десять: 10, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, пять: 5, пятнадцать: 15, двадцать5: 25 }
const WORDS_EN: Record<string, number> = { zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, five: 5, fifteen: 15 }

function level(s: string): number | null {
  const d = s.match(/\b(\d{1,3})\b/)
  if (d) return Math.min(100, Number(d[1]))
  for (const w of s.split(' ')) {
    if (w in WORDS_RU) return WORDS_RU[w]
    if (w in WORDS_EN) return WORDS_EN[w]
  }
  return null
}

export function matchFast(raw: string): FastAction | null {
  const t = N(raw)
  if (!t || t.length > 60) return null
  const strip = t.replace(/^(джарвис |jarvis |пожалуйста |please |сделай |make it |can you |could you |ты можешь |можешь )+/, '').replace(/ (пожалуйста|please|сэр|sir)$/, '')

  // ---- absolute volume: "громкость 40", "volume to 40 percent", "сделай звук на тридцать процентов"
  if (/^(громкость|звук|volume|set volume)( на| до| to| at)? /.test(strip) || /^(поставь|установи|set) (громкость|звук|volume)( на| до| to)? /.test(strip)) {
    const l = level(strip)
    if (l !== null) return { kind: 'volume', action: 'set', level: l, say: [`Громкость ${l} процентов, сэр.`, `Volume at ${l} percent, sir.`] }
  }
  if (/^(выключи звук|отключи звук|без звука|заглуши( звук)?|mute( the)?( sound| volume)?|silence)$/.test(strip)) return { kind: 'volume', action: 'mute', say: ['Звук выключен.', 'Muted.'] }
  if (/^(включи звук|верни звук|unmute( the)?( sound| volume)?)$/.test(strip)) return { kind: 'volume', action: 'unmute', say: ['Звук включён.', 'Sound is back on.'] }
  if (/^(погромче|громче|прибавь( звук| громкость)?|добавь( звук| громкость)?|увеличь( громкость| звук)?|louder|volume up|turn (it |the volume |the sound )?up|increase( the)? volume|raise( the)? volume)$/.test(strip)) return { kind: 'volume', action: 'up', step: 10, say: ['Громче.', 'Louder.'] }
  if (/^(потише|тише|убавь( звук| громкость)?|уменьши( громкость| звук)?|quieter|softer|volume down|turn (it |the volume |the sound )?down|decrease( the)? volume|lower( the)? volume)$/.test(strip)) return { kind: 'volume', action: 'down', step: 10, say: ['Тише.', 'Quieter.'] }
  if (/^(намного |сильно )?(громче|тише)$/.test(strip)) return { kind: 'volume', action: strip.endsWith('громче') ? 'up' : 'down', step: 25, say: ['Сделано.', 'Done.'] }

  // ---- media keys
  if (/^(пауза|поставь на паузу|останови музыку|останови( воспроизведение)?|pause( the)?( music| song| video| track)?|stop( the)? music)$/.test(strip)) return { kind: 'media', action: 'play_pause', say: ['Пауза.', 'Paused.'] }
  if (/^(продолжи|продолжай( играть)?|сними с паузы|resume( the)?( music| playback)?|unpause|play)$/.test(strip)) return { kind: 'media', action: 'play_pause', say: ['Продолжаю.', 'Resuming.'] }
  if (/^(следующий( трек| песня| клип)?|дальше|следующая( песня)?|переключи( трек)?|next( track| song)?|skip( this)?( track| song)?)$/.test(strip)) return { kind: 'media', action: 'next', say: ['Следующий.', 'Next.'] }
  if (/^(предыдущий( трек| песня)?|назад|предыдущая( песня)?|previous( track| song)?|go back|last (track|song))$/.test(strip)) return { kind: 'media', action: 'previous', say: ['Предыдущий.', 'Previous.'] }

  // ---- desktop
  if (/^(сверни все( окна)?|покажи рабочий стол|убери все окна|show( the)? desktop|minimi[sz]e all( windows)?|hide all windows)$/.test(strip)) return { kind: 'desktop', action: 'show_desktop', say: ['Рабочий стол, сэр.', 'Desktop, sir.'] }
  if (/^(верни( все)? окна|разверни все( окна)?|restore( all)?( windows)?|bring back( my)? windows)$/.test(strip)) return { kind: 'desktop', action: 'restore_all', say: ['Окна возвращены.', 'Windows restored.'] }
  if (/^(заблокируй( компьютер| экран| пк)?|lock( the)?( computer| screen| pc)?)$/.test(strip)) return { kind: 'desktop', action: 'lock', say: ['Блокирую.', 'Locking.'] }
  return null
}
