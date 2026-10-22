import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Edit3, Mic, Play, Plus, Trash2, X } from 'lucide-react'
import type { Routine, RoutineStep } from '@shared/types'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

const STEP_TYPES: RoutineStep['type'][] = ['say', 'open', 'run', 'keys', 'type', 'wait', 'agent']

const stepText = (s: RoutineStep): string => {
  switch (s.type) {
    case 'say': return s.text
    case 'open': return s.target
    case 'run': return s.command
    case 'keys': return s.keys
    case 'type': return s.text
    case 'wait': return `${s.ms} ms`
    case 'agent': return s.prompt
  }
}
const withText = (s: RoutineStep, v: string): RoutineStep => {
  switch (s.type) {
    case 'say': return { type: 'say', text: v }
    case 'open': return { type: 'open', target: v }
    case 'run': return { type: 'run', command: v }
    case 'keys': return { type: 'keys', keys: v }
    case 'type': return { type: 'type', text: v }
    case 'wait': return { type: 'wait', ms: Number(v) || 500 }
    case 'agent': return { type: 'agent', prompt: v }
  }
}
const blank = (type: RoutineStep['type']): RoutineStep => withText({ type } as RoutineStep, type === 'wait' ? '500' : '')

function Editor({ initial, onClose }: { initial: Partial<Routine>; onClose: () => void }) {
  const { t } = useT()
  const [name, setName] = useState(initial.name ?? '')
  const [phrases, setPhrases] = useState<string[]>(initial.phrases ?? [])
  const [draft, setDraft] = useState('')
  const [steps, setSteps] = useState<RoutineStep[]>(initial.steps ?? [blank('say')])
  const addPhrase = () => {
    const p = draft.trim()
    if (p && !phrases.includes(p)) setPhrases([...phrases, p])
    setDraft('')
  }
  const save = async () => {
    if (!name.trim() || !phrases.length) return
    await api.invoke(IPC.routinesSave, { id: initial.id, name: name.trim(), phrases, steps })
    await useApp.getState().loadRoutines()
    onClose()
  }
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.div className="modal" initial={{ y: 24, scale: 0.97, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 12, opacity: 0 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial.id ? t('routines.edit') : t('routines.new')}</h2>
        <label className="field-label">{t('routines.name')}</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hello" autoFocus />
        <label className="field-label">{t('routines.phrases')}</label>
        <div className="tags">
          {phrases.map((p) => (
            <span className="tag" key={p}>
              {p}
              <button onClick={() => setPhrases(phrases.filter((x) => x !== p))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <input value={draft} placeholder="+" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ',') && (e.preventDefault(), addPhrase())} onBlur={addPhrase} />
        </div>
        <label className="field-label">{t('routines.steps')}</label>
        {steps.map((s, i) => (
          <div className="step-edit" key={i}>
            <select className="select" value={s.type} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? blank(e.target.value as RoutineStep['type']) : x)))}>
              {STEP_TYPES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input className="input" value={stepText(s)} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? withText(x, e.target.value) : x)))} />
            <button className="icon-btn" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
              <X size={16} />
            </button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setSteps([...steps, blank('say')])}>
          <Plus size={14} /> {t('routines.addStep')}
        </button>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <button className="btn" onClick={onClose}>
            {t('routines.cancel')}
          </button>
          <button className="btn primary" onClick={save}>
            {t('routines.save')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export function RoutinesPage() {
  const { t } = useT()
  const routines = useApp((s) => s.routines)
  const [editing, setEditing] = useState<Partial<Routine> | null>(null)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('routines.title')}</h1>
          <p>{t('routines.sub')}</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({})}>
          <Plus size={16} /> {t('routines.new')}
        </button>
      </div>
      <div className="scroll">
        {routines.length === 0 ? (
          <div className="empty" style={{ marginTop: 80 }}>
            <Mic size={34} style={{ color: 'var(--accent)', marginBottom: 14 }} />
            <div>{t('routines.empty')}</div>
          </div>
        ) : (
          <div className="grid">
            <AnimatePresence>
              {routines.map((r) => (
                <motion.div key={r.id} className="glass rcard" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}>
                  <div>
                    <h4>{r.name}</h4>
                    <div className="tags" style={{ marginTop: 8 }}>
                      {r.phrases.map((p) => (
                        <span key={p} className="tag" style={{ padding: '3px 11px' }}>
                          “{p}”
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="steps">
                    {r.steps.map((s, i) => (
                      <div className="step" key={i}>
                        <b>{s.type}</b>
                        <span>{stepText(s)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="actions">
                    <button className="btn sm primary" onClick={() => api.invoke(IPC.routinesRun, r.id)}>
                      <Play size={13} /> {t('routines.run')}
                    </button>
                    <button className="btn sm" onClick={() => setEditing(r)}>
                      <Edit3 size={13} /> {t('routines.edit')}
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        await api.invoke(IPC.routinesDelete, r.id)
                        await useApp.getState().loadRoutines()
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
      <AnimatePresence>{editing && <Editor key={editing.id ?? 'new'} initial={editing} onClose={() => setEditing(null)} />}</AnimatePresence>
    </div>
  )
}
