import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion } from 'framer-motion'
import './styles.css'
import type { HighlightTarget } from '@shared/types'
import { api, IPC } from './api'
import { applyTheme } from './theme'

let ACCENT = '#38d6ff'

function Corner({ x, y, rot, len = 16 }: { x: number; y: number; rot: number; len?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <path d={`M0 ${len} V0 H${len}`} fill="none" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
    </g>
  )
}

function Target({ t, i }: { t: HighlightTarget; i: number }) {
  const pad = 8
  const x = t.x - pad
  const y = t.y - pad
  const w = t.w + pad * 2
  const h = t.h + pad * 2
  const shape = t.shape ?? 'box'
  const cx = x + w / 2
  const cy = y + h / 2
  const labelBelow = y < 46
  return (
    <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ delay: i * 0.12, duration: 0.3 }}>
      {shape === 'box' && (
        <>
          <motion.rect x={x} y={y} width={w} height={h} rx={10} fill="rgba(56,214,255,0.10)" stroke={ACCENT} strokeWidth={1.5} initial={{ scale: 1.18, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 22, delay: i * 0.12 }} style={{ transformOrigin: `${cx}px ${cy}px`, filter: `drop-shadow(0 0 10px ${ACCENT})` }} />
          <motion.rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke={ACCENT} strokeWidth={2} animate={{ scale: [1, 1.12], opacity: [0.7, 0] }} transition={{ repeat: Infinity, duration: 1.6, ease: 'easeOut' }} style={{ transformOrigin: `${cx}px ${cy}px` }} />
          <g style={{ filter: `drop-shadow(0 0 6px ${ACCENT})` }}>
            <Corner x={x - 3} y={y - 3} rot={0} />
            <Corner x={x + w + 3} y={y - 3} rot={90} />
            <Corner x={x + w + 3} y={y + h + 3} rot={180} />
            <Corner x={x - 3} y={y + h + 3} rot={270} />
          </g>
          <motion.line x1={x + 6} x2={x + w - 6} stroke={ACCENT} strokeWidth={1.5} strokeOpacity={0.7} animate={{ y1: [y + 4, y + h - 4, y + 4], y2: [y + 4, y + h - 4, y + 4] }} transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }} />
        </>
      )}
      {shape === 'circle' && (
        <>
          <motion.ellipse cx={cx} cy={cy} rx={w / 2 + 6} ry={h / 2 + 6} fill="rgba(56,214,255,0.08)" stroke={ACCENT} strokeWidth={2.5} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6 }} style={{ filter: `drop-shadow(0 0 10px ${ACCENT})` }} />
          <motion.ellipse cx={cx} cy={cy} rx={w / 2 + 6} ry={h / 2 + 6} fill="none" stroke={ACCENT} strokeWidth={2} animate={{ scale: [1, 1.25], opacity: [0.7, 0] }} transition={{ repeat: Infinity, duration: 1.5 }} style={{ transformOrigin: `${cx}px ${cy}px` }} />
        </>
      )}
      {shape === 'underline' && (
        <motion.line x1={x} x2={x + w} y1={y + h} y2={y + h} stroke={ACCENT} strokeWidth={4} strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5 }} style={{ filter: `drop-shadow(0 0 8px ${ACCENT})` }} />
      )}
      {shape === 'arrow' && (
        <motion.g animate={{ x: [0, 8, 0], y: [0, 8, 0] }} transition={{ repeat: Infinity, duration: 1.1 }} style={{ filter: `drop-shadow(0 0 8px ${ACCENT})` }}>
          <path d={`M${x - 60} ${y - 60} L${x - 8} ${y - 8}`} stroke={ACCENT} strokeWidth={5} strokeLinecap="round" />
          <path d={`M${x - 8} ${y - 8} l-22 4 M${x - 8} ${y - 8} l4 -22`} stroke={ACCENT} strokeWidth={5} strokeLinecap="round" />
        </motion.g>
      )}
      {t.label && (
        <foreignObject x={x} y={labelBelow ? y + h + 10 : y - 40} width={Math.max(220, w)} height={34} style={{ overflow: 'visible' }}>
          <motion.div initial={{ opacity: 0, y: labelBelow ? -6 : 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.12 }} style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 9, background: 'rgba(4,10,16,0.88)', border: `1px solid ${ACCENT}`, color: '#eaf8ff', fontFamily: 'Bahnschrift, Segoe UI', fontSize: 14, letterSpacing: '0.03em', boxShadow: `0 0 18px -4px ${ACCENT}`, whiteSpace: 'nowrap', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t.label}
          </motion.div>
        </foreignObject>
      )}
    </motion.g>
  )
}

function ControlGlow({ hint, primary }: { hint: string; primary: boolean }) {
  return (
    <motion.div className="ov-control" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
      <motion.div className="ov-edge" animate={{ opacity: [0.65, 1, 0.65] }} transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }} />
      <div className="ov-sweep" />
      {primary && (
        <motion.div className="ov-badge" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
          <span className="pulse" />
          <b>JARVIS</b>
          <span>{hint}</span>
        </motion.div>
      )}
    </motion.div>
  )
}

function Overlay() {
  const [targets, setTargets] = useState<HighlightTarget[]>([])
  const [control, setControl] = useState<{ on: boolean; hint: string; primary: boolean }>({ on: false, hint: '', primary: true })
  const [, bump] = useState(0)
  useEffect(() => {
    const apply = (s: { accent?: string; theme?: any } | undefined) => {
      if (!s?.accent) return
      ACCENT = s.accent
      applyTheme(s.accent, s.theme ?? 'dark')
      bump((n) => n + 1)
    }
    void api.invoke(IPC.settingsGet).then(apply)
    const offS = api.on(IPC.settingsChanged, apply)
    const off1 = api.on(IPC.highlight, (list: HighlightTarget[]) => setTargets(list))
    const off2 = api.on(IPC.highlightClear, () => setTargets([]))
    const off3 = api.on('overlay:control', (on: boolean, hint: string, primary: boolean) => setControl({ on, hint, primary }))
    return () => {
      off1()
      off2()
      off3()
      offS()
    }
  }, [])
  return (
    <div className="ov-root">
      <AnimatePresence>{control.on && <ControlGlow hint={control.hint} primary={control.primary} />}</AnimatePresence>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <mask id="hole">
            <rect width="100%" height="100%" fill="white" />
            {targets.map((t, i) => (
              <rect key={i} x={t.x - 10} y={t.y - 10} width={t.w + 20} height={t.h + 20} rx={12} fill="black" />
            ))}
          </mask>
        </defs>
        <AnimatePresence>{targets.length > 0 && <motion.rect key="dim" width="100%" height="100%" fill="rgba(2,8,14,0.38)" mask="url(#hole)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} />}</AnimatePresence>
        <AnimatePresence>
          {targets.map((t, i) => (
            <Target key={`${t.x}-${t.y}-${i}`} t={t} i={i} />
          ))}
        </AnimatePresence>
      </svg>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
