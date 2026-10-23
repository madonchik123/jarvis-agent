import type { RoutineStep } from './types'

export const STEP_TYPES: RoutineStep['type'][] = ['say', 'open', 'focus', 'click', 'type', 'keys', 'hold', 'scroll', 'move', 'wait', 'run', 'agent']

/** What to type into the one-line editor for each step type. */
export const STEP_HINT: Record<RoutineStep['type'], [string, string]> = {
  say: ['Доброе утро, сэр.', 'Good morning, sir.'],
  open: ['Spotify · https://… · C:\\file.pdf', 'Spotify · https://… · C:\\file.pdf'],
  focus: ['Telegram (заголовок окна или приложение)', 'Telegram (window title or app)'],
  click: ['Отправить · 640,360 · 640,360 right · 640,360 double', 'Send · 640,360 · 640,360 right · 640,360 double'],
  type: ['текст для ввода', 'text to type'],
  keys: ['ctrl+shift+t · ctrl+a delete · enter', 'ctrl+shift+t · ctrl+a delete · enter'],
  hold: ['w 800 (клавиши и мс; scan — для игр)', 'w 800 (keys and ms; add scan for games)'],
  scroll: ['down 5 · up 3 @ 800,400', 'down 5 · up 3 @ 800,400'],
  move: ['800,400', '800,400'],
  wait: ['1000', '1000'],
  run: ['PowerShell команда', 'PowerShell command'],
  agent: ['задача для Джарвиса своими словами', 'a task for Jarvis in plain words']
}

const pt = (v: string) => {
  const m = v.match(/(-?\d+)\s*[,; ]\s*(-?\d+)/)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

/** One-line editor text → step. */
export function parseStep(type: RoutineStep['type'], v: string, after?: number): RoutineStep {
  const t = v.trim()
  const extra = after ? { after } : {}
  switch (type) {
    case 'say': return { type, text: t, ...extra }
    case 'open': return { type, target: t, ...extra }
    case 'focus': return { type, target: t, ...extra }
    case 'run': return { type, command: t, ...extra }
    case 'agent': return { type, prompt: t, ...extra }
    case 'type': return { type, text: v, ...extra }
    case 'keys': return { type, keys: t.replace(/\s+scan$/i, ''), ...(/\sscan$/i.test(t) ? { scan: true } : {}), ...extra }
    case 'wait': return { type, ms: Math.max(0, Number(t.replace(/[^\d.]/g, '')) || 500), ...extra }
    case 'move': {
      const p = pt(t) ?? { x: 0, y: 0 }
      return { type, ...p, ...extra }
    }
    case 'click': {
      const p = /^\s*-?\d+\s*[,; ]\s*-?\d+/.test(t) ? pt(t) : null
      const button = /\bright\b|прав/i.test(t) ? 'right' : /\bmiddle\b|средн/i.test(t) ? 'middle' : undefined
      const count = /\bdouble\b|двойн/i.test(t) ? 2 : undefined
      return p ? { type, ...p, ...(button ? { button } : {}), ...(count ? { count } : {}), ...extra } : { type, text: t, ...(button ? { button } : {}), ...(count ? { count } : {}), ...extra }
    }
    case 'scroll': {
      const dir = (t.match(/\b(up|down|left|right)\b/i)?.[1]?.toLowerCase() ?? (/вверх/i.test(t) ? 'up' : /влево/i.test(t) ? 'left' : /вправо/i.test(t) ? 'right' : 'down')) as 'up' | 'down' | 'left' | 'right'
      const amount = Number(t.replace(/@.*$/, '').match(/\d+/)?.[0] ?? 5)
      const at = t.includes('@') ? pt(t.split('@')[1]) : null
      return { type, direction: dir, amount, ...(at ?? {}), ...extra }
    }
    case 'hold': {
      const m = t.match(/^(\S+)\s+(\d+)/)
      return { type, keys: m?.[1] ?? (t.split(/\s+/)[0] || 'w'), ms: Number(m?.[2] ?? 500), ...(/\bscan\b/i.test(t) ? { scan: true } : {}), ...extra }
    }
  }
}

/** Step → one-line editor text (inverse of parseStep). */
export function stepText(s: RoutineStep): string {
  switch (s.type) {
    case 'say': return s.text
    case 'open': return s.target
    case 'focus': return s.target
    case 'run': return s.command
    case 'agent': return s.prompt
    case 'type': return s.text
    case 'keys': return s.keys + (s.scan ? ' scan' : '')
    case 'wait': return String(s.ms)
    case 'move': return `${s.x},${s.y}`
    case 'click': return (s.text ?? `${s.x ?? 0},${s.y ?? 0}`) + (s.button && s.button !== 'left' ? ` ${s.button}` : '') + (s.count === 2 ? ' double' : '')
    case 'scroll': return `${s.direction} ${s.amount}` + (s.x !== undefined ? ` @ ${s.x},${s.y}` : '')
    case 'hold': return `${s.keys} ${s.ms}` + (s.scan ? ' scan' : '')
  }
}
