import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion } from 'framer-motion'
import './styles.css'
import { Orb } from './components/Orb'
import { PermissionStack } from './components/Overlays'
import { api, IPC } from './api'
import { bootstrap, useApp, useT } from './store'
import { applyTheme } from './theme'
// microphone capture + speech playback live in this always-present window
if (!new URLSearchParams(location.search).has('noaudio')) void import('./audio')

function Hud() {
  const ready = useApp((s) => s.ready)
  const status = useApp((s) => s.status)
  const settings = useApp((s) => s.settings)
  const subtitle = useApp((s) => s.subtitle)
  const partial = useApp((s) => s.partial)
  const { t } = useT()
  useEffect(() => void bootstrap(), [])
  useEffect(() => applyTheme(settings.accent, settings.theme), [settings.accent, settings.theme])
  if (!ready) return null

  const active = status.state !== 'idle'
  const live = status.state === 'listening' || status.state === 'wake' ? partial : ''
  const act = status.state === 'thinking' && status.activity ? '⚙ ' + status.activity : ''
  const text = settings.showSubtitles ? subtitle || live || act : ''
  const right = settings.hudCorner.endsWith('r')
  return (
    <div className="hud-root" style={{ alignItems: right ? 'flex-end' : 'flex-start', justifyContent: settings.hudCorner.startsWith('b') ? 'flex-end' : 'flex-start', flexDirection: settings.hudCorner.startsWith('b') ? 'column' : 'column-reverse' }}>
      <PermissionStack inline />
      <AnimatePresence>
        {text && (
          <motion.div key={text} className={'hud-sub' + (subtitle ? '' : ' live')} initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
            {text}
          </motion.div>
        )}
      </AnimatePresence>
      <div style={{ display: 'flex', alignItems: 'center', flexDirection: right ? 'row' : 'row-reverse' }}>
        <AnimatePresence>
          {active && (
            <motion.div className="hud-state" initial={{ opacity: 0, x: right ? 10 : -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} style={{ marginRight: right ? 14 : 0, marginLeft: right ? 0 : 14 }}>
              {t('state.' + status.state)}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          className="hud-orb"
          animate={{ scale: active ? 1 : 0.62, opacity: active ? 1 : 0.92 }}
          transition={{ type: 'spring', stiffness: 220, damping: 22 }}
          style={{ transformOrigin: right ? 'bottom right' : 'bottom left' }}
          onMouseEnter={() => api.send(IPC.window, 'hud-interactive')}
          onMouseLeave={() => api.send(IPC.window, 'hud-passthrough')}
          onClick={() => api.send(IPC.window, 'showMain')}
        >
          <Orb state={status.state} size={150} accent={settings.accent} compact />
        </motion.div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Hud />)
