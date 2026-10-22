import { useEffect, useRef } from 'react'
import type { AssistantState } from '@shared/types'
import { levels } from '../api'

interface Props {
  state: AssistantState
  size?: number
  accent: string
  /** when true the orb never reacts to mic level (mini HUD uses smaller work) */
  compact?: boolean
}

type RGB = [number, number, number]

const hexToRgb = (hex: string): RGB => {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`

const TAU = Math.PI * 2

interface Mood {
  color: RGB
  spin: number
  energy: number
  core: number
}

function moodFor(state: AssistantState, accent: RGB): Mood {
  const warm: RGB = [255, 190, 90]
  const violet: RGB = [150, 130, 255]
  const red: RGB = [255, 90, 110]
  switch (state) {
    case 'wake':
    case 'listening':
      return { color: mix(accent, [255, 255, 255], 0.25), spin: 1.6, energy: 1, core: 1.1 }
    case 'transcribing':
      return { color: mix(accent, violet, 0.5), spin: 3.2, energy: 0.7, core: 1 }
    case 'thinking':
      return { color: mix(accent, violet, 0.75), spin: 4.2, energy: 0.6, core: 0.95 }
    case 'speaking':
      return { color: mix(accent, warm, 0.55), spin: 1.2, energy: 1, core: 1.15 }
    case 'error':
      return { color: red, spin: 0.6, energy: 0.3, core: 0.8 }
    default:
      return { color: accent, spin: 0.35, energy: 0.25, core: 0.85 }
  }
}

export function Orb({ state, size = 360, accent, compact }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const accentRef = useRef(accent)
  stateRef.current = state
  accentRef.current = accent

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const S = {
      color: hexToRgb(accentRef.current) as RGB,
      spin: 0.35,
      energy: 0.25,
      core: 0.85,
      lvl: 0,
      phase: [0, 0, 0, 0],
      t: 0,
      bars: new Float32Array(96),
      pulse: 0,
      lastState: stateRef.current
    }
    const particles = Array.from({ length: compact ? 10 : 26 }, (_, i) => ({
      a: Math.random() * TAU,
      r: 0.42 + Math.random() * 0.34,
      s: (0.15 + Math.random() * 0.5) * (i % 2 ? 1 : -1),
      z: 0.6 + Math.random() * 1.6
    }))

    let raf = 0
    let last = performance.now()

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      S.t += dt
      const st = stateRef.current
      const target = moodFor(st, hexToRgb(accentRef.current))
      const k = 1 - Math.pow(0.002, dt)
      S.color = mix(S.color, target.color, k)
      S.spin += (target.spin - S.spin) * k
      S.energy += (target.energy - S.energy) * k
      S.core += (target.core - S.core) * k
      if (st !== S.lastState) {
        S.pulse = 1
        S.lastState = st
      }
      S.pulse = Math.max(0, S.pulse - dt * 1.4)

      const raw = st === 'speaking' ? levels.tts : st === 'listening' || st === 'wake' ? levels.mic : 0
      S.lvl += (raw - S.lvl) * (1 - Math.pow(0.0004, dt))
      const lvl = S.lvl
      const breath = 0.5 + 0.5 * Math.sin(S.t * 1.4)

      const c = S.color
      const cx = size / 2
      const cy = size / 2
      const R = size / 2
      ctx.clearRect(0, 0, size, size)
      ctx.globalCompositeOperation = 'lighter'

      // ambient glow
      const g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 0.95)
      g.addColorStop(0, rgba(c, 0.32 + 0.35 * lvl + 0.08 * breath + S.pulse * 0.25))
      g.addColorStop(0.35, rgba(c, 0.1 + 0.12 * S.energy))
      g.addColorStop(1, rgba(c, 0))
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)

      // outer scale ring with ticks
      S.phase[0] += dt * S.spin * 0.12
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(S.phase[0])
      ctx.strokeStyle = rgba(c, 0.35)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.94, 0, TAU)
      ctx.stroke()
      const ticks = 120
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * TAU
        const long = i % 10 === 0
        const r1 = R * 0.94
        const r2 = r1 - (long ? R * 0.045 : R * 0.02)
        ctx.strokeStyle = rgba(c, long ? 0.55 : 0.22)
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1)
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2)
        ctx.stroke()
      }
      ctx.restore()

      // segmented rotating arcs
      const rings: [number, number, number, number, number][] = [
        // radius, speed, width, segments, alpha
        [0.84, 0.5, 2.2, 3, 0.75],
        [0.74, -0.8, 1.4, 7, 0.55],
        [0.52, 1.2, 3.4, 4, 0.65]
      ]
      rings.forEach(([rr, sp, w, segs, al], idx) => {
        S.phase[idx + 1] += dt * sp * S.spin
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(S.phase[idx + 1])
        ctx.lineWidth = w * (size / 360)
        ctx.lineCap = 'round'
        const gap = 0.35
        const seg = TAU / segs
        for (let i = 0; i < segs; i++) {
          const a0 = i * seg + gap / 2
          const a1 = (i + 1) * seg - gap / 2
          ctx.strokeStyle = rgba(c, al * (0.55 + 0.45 * Math.sin(S.t * 2 + i + idx)) * (0.6 + 0.4 * S.energy + lvl * 0.4))
          ctx.beginPath()
          ctx.arc(0, 0, R * rr * (1 + lvl * 0.025), a0, a1)
          ctx.stroke()
        }
        ctx.restore()
      })

      // radial spectrum bars
      const n = S.bars.length
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + S.phase[0] * 0.5
        const noise = 0.5 + 0.5 * Math.sin(S.t * 3.1 + i * 0.7) * Math.sin(S.t * 1.7 + i * 0.23)
        const idle = 0.06 + 0.05 * Math.sin(S.t * 1.2 + i * 0.4)
        const want = idle + (0.05 + 0.5 * lvl) * noise * (0.4 + S.energy)
        S.bars[i] += (want - S.bars[i]) * (1 - Math.pow(0.001, dt))
        const r1 = R * 0.62
        const r2 = r1 + R * S.bars[i] * 0.42
        ctx.strokeStyle = rgba(c, 0.25 + S.bars[i] * 1.3)
        ctx.lineWidth = (size / 360) * 1.6
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
        ctx.stroke()
      }

      // particles
      for (const p of particles) {
        p.a += dt * p.s * (0.4 + S.spin * 0.5)
        const px = cx + Math.cos(p.a) * R * p.r
        const py = cy + Math.sin(p.a) * R * p.r * 0.96
        const pr = p.z * (size / 360) * (1 + lvl)
        const pg = ctx.createRadialGradient(px, py, 0, px, py, pr * 4)
        pg.addColorStop(0, rgba(c, 0.9))
        pg.addColorStop(1, rgba(c, 0))
        ctx.fillStyle = pg
        ctx.beginPath()
        ctx.arc(px, py, pr * 4, 0, TAU)
        ctx.fill()
      }

      // core
      const coreR = R * 0.27 * S.core * (1 + 0.1 * breath * (1 - S.energy) + lvl * 0.28 + S.pulse * 0.12)
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.8)
      cg.addColorStop(0, rgba(mix(c, [255, 255, 255], 0.8), 0.98))
      cg.addColorStop(0.35, rgba(mix(c, [255, 255, 255], 0.3), 0.85))
      cg.addColorStop(0.7, rgba(c, 0.35))
      cg.addColorStop(1, rgba(c, 0))
      ctx.fillStyle = cg
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 1.8, 0, TAU)
      ctx.fill()

      // inner thin rings
      ctx.strokeStyle = rgba(mix(c, [255, 255, 255], 0.5), 0.55)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 1.05, 0, TAU)
      ctx.stroke()
      ctx.strokeStyle = rgba(c, 0.3)
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 1.35 + S.pulse * R * 0.25, 0, TAU)
      ctx.stroke()

      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size, compact])

  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />
}
