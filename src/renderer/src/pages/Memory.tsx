import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Brain, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

export function MemoryPage() {
  const { t } = useT()
  const memory = useApp((s) => s.memory)
  const [text, setText] = useState('')
  const reload = () => useApp.getState().loadMemory()
  const add = async () => {
    if (!text.trim()) return
    await api.invoke(IPC.memoryAdd, text.trim())
    setText('')
    await reload()
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('memory.title')}</h1>
          <p>{t('memory.sub')}</p>
        </div>
      </div>
      <div className="composer" style={{ borderTop: 0, padding: '0 4px 14px' }}>
        <div className="field">
          <input value={text} placeholder={t('memory.add')} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        </div>
        <button className="icon-btn primary" onClick={add}>
          <Plus size={19} />
        </button>
      </div>
      <div className="scroll">
        {memory.length === 0 ? (
          <div className="empty" style={{ marginTop: 80 }}>
            <Brain size={34} style={{ color: 'var(--accent)', marginBottom: 14 }} />
            <div>{t('memory.empty')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <AnimatePresence initial={false}>
              {memory.map((m) => (
                <motion.div key={m.id} className={'mem' + (m.pinned ? ' pinned' : '')} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
                  <p>{m.text}</p>
                  <button
                    className="icon-btn"
                    title="pin"
                    style={{ color: m.pinned ? 'var(--accent)' : undefined }}
                    onClick={async () => {
                      await api.invoke(IPC.memoryPin, m.id, !m.pinned)
                      await reload()
                    }}
                  >
                    {m.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={async () => {
                      await api.invoke(IPC.memoryDelete, m.id)
                      await reload()
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}
