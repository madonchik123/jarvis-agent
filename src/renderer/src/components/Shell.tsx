import { motion } from 'framer-motion'
import { Brain, Minus, MessageSquare, Settings as Cog, Square, X, Zap } from 'lucide-react'
import { api, IPC } from '../api'
import { Page, useApp, useT } from '../store'

export function TitleBar() {
  const { t } = useT()
  return (
    <div className="titlebar">
      <div className="brand">
        <i />
        JARVIS
      </div>
      <div className="winbtns">
        <button title={t('ui.minimize')} onClick={() => api.send(IPC.window, 'minimize')}>
          <Minus size={16} />
        </button>
        <button onClick={() => api.send(IPC.window, 'maximize')}>
          <Square size={12} />
        </button>
        <button className="close" title={t('ui.close')} onClick={() => api.send(IPC.window, 'close')}>
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

const items: { id: Page; icon: typeof Brain; key: string }[] = [
  { id: 'assistant', icon: MessageSquare, key: 'nav.assistant' },
  { id: 'routines', icon: Zap, key: 'nav.routines' },
  { id: 'memory', icon: Brain, key: 'nav.memory' }
]

export function Rail() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const { t } = useT()
  const Btn = ({ id, icon: Icon, label }: { id: Page; icon: typeof Brain; label: string }) => (
    <button className={'navbtn' + (page === id ? ' active' : '')} onClick={() => setPage(id)}>
      {page === id && <motion.span layoutId="nav-pill" className="pill" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
      <Icon size={21} strokeWidth={1.7} />
      {label}
    </button>
  )
  return (
    <nav className="rail">
      {items.map((it) => (
        <Btn key={it.id} id={it.id} icon={it.icon} label={t(it.key)} />
      ))}
      <div className="spacer" />
      <Btn id="settings" icon={Cog} label={t('nav.settings')} />
    </nav>
  )
}
