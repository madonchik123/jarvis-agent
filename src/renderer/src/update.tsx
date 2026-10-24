// The update window: a small Jarvis-styled card instead of system dialogs — new version + notes → download progress → restart.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { motion, AnimatePresence } from 'framer-motion'
import './styles.css'
import { Orb } from './components/Orb'
import { api, IPC } from './api'
import type { Settings, UpdateState } from '@shared/types'
import { applyTheme } from './theme'

function fmtSpeed(bps?: number) {
  if (!bps) return ''
  return bps > 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
}

function UpdateCard() {
  const [u, setU] = useState<UpdateState | null>(null)
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => {
    void api.invoke('update:state').then(setU)
    void api.invoke(IPC.settingsGet).then((x: Settings) => {
      setS(x)
      applyTheme(x.accent, 'dark')
    })
    return api.on('update:changed', setU)
  }, [])
  if (!u || !s) return null
  const ru = s.interfaceLang === 'ru' || (s.interfaceLang !== 'en' && navigator.language.startsWith('ru'))
  const L = (r: string, e: string) => (ru ? r : e)
  const close = () => api.invoke('update:close')
  const st = u.status

  const title =
    st === 'downloaded' ? L('Обновление готово', 'Update ready') : st === 'downloading' ? L('Загружаю обновление…', 'Downloading the update…') : st === 'error' ? L('Не удалось обновиться', "Couldn't update") : L('Доступна новая версия', 'A new version is available')
  const sub =
    st === 'downloaded'
      ? L(`Jarvis ${u.version} установится за пару секунд и сразу перезапустится.`, `Jarvis ${u.version} installs in a few seconds and restarts right away.`)
      : st === 'error'
        ? u.error || ''
        : L(`Jarvis ${u.version ?? ''} — сейчас у вас ${u.current}.`, `Jarvis ${u.version ?? ''} — you have ${u.current}.`)
  const notes = (u.notes || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/^[-*#\s]+/, '').trim()).filter(Boolean).slice(0, 4)

  return (
    <div className="upd">
      <div className="upd-drag" />
      <button className="upd-x" onClick={close} aria-label="close">
        ✕
      </button>
      <div className="upd-orb">
        <Orb state={st === 'downloading' ? 'thinking' : st === 'downloaded' ? 'speaking' : 'idle'} size={120} accent={s.accent} compact />
      </div>
      <div className="upd-body">
        <div className="upd-ver">v{u.current} → v{u.version ?? '…'}</div>
        <h2>{title}</h2>
        <p className="upd-sub">{sub}</p>
        <AnimatePresence mode="wait">
          {st === 'available' && notes.length > 0 && (
            <motion.ul key="notes" className="upd-notes" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </motion.ul>
          )}
          {st === 'downloading' && (
            <motion.div key="bar" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="upd-track">
                <motion.div className="upd-fill" animate={{ width: `${u.percent ?? 0}%` }} transition={{ ease: 'easeOut', duration: 0.4 }} />
              </div>
              <div className="upd-meta">
                <span>{fmtSpeed(u.bytesPerSecond)}</span>
                <span className="upd-pct">{u.percent ?? 0}%</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="upd-actions">
          {st === 'available' && (
            <>
              <button className="btn" onClick={close}>
                {L('Позже', 'Later')}
              </button>
              <button className="btn primary" onClick={() => api.invoke('update:download')}>
                {L('Обновить', 'Update')}
              </button>
            </>
          )}
          {st === 'downloading' && (
            <button className="btn" onClick={close}>
              {L('Скрыть', 'Hide')}
            </button>
          )}
          {st === 'downloaded' && (
            <>
              <button className="btn" onClick={close}>
                {L('При выходе', 'On exit')}
              </button>
              <button className="btn primary" onClick={() => api.invoke('update:install')}>
                {L('Перезапустить', 'Restart now')}
              </button>
            </>
          )}
          {st === 'error' && (
            <button className="btn" onClick={close}>
              {L('Закрыть', 'Close')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<UpdateCard />)
