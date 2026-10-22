import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, ShieldCheck } from 'lucide-react'
import type { PermissionRequest } from '@shared/types'
import { Orb } from './Orb'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

export function PermissionStack({ inline }: { inline?: boolean }) {
  const perms = useApp((s) => s.permissions)
  const { t } = useT()
  const [answer, setAnswer] = useState('')
  const reply = (r: PermissionRequest, a: any) => {
    api.invoke(IPC.permissionReply, r.id, a)
    useApp.setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== r.id) }))
    setAnswer('')
  }
  return (
    <div className={'perm-stack' + (inline ? ' inline' : '')}>
      <AnimatePresence>
        {perms.map((r) => (
          <motion.div key={r.id} className="perm" initial={inline ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.95 }} animate={inline ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }} exit={inline ? { opacity: 0 } : { opacity: 0, x: 60 }} transition={inline ? { duration: 0.18 } : { type: 'spring', stiffness: 380, damping: 30 }}>
            <div className="t">{r.kind === 'question' ? t('perm.question') : t('perm.title')}</div>
            <div className="q">{r.title}</div>
            {r.detail && <code>{r.detail}</code>}
            {r.hint && (
              <div className="perm-hint">
                <i /> {r.hint}
              </div>
            )}
            {r.kind === 'permission' ? (
              <div className="btns">
                <button className="btn primary sm" onClick={() => reply(r, 'once')}>
                  <ShieldCheck size={14} /> {t('perm.allow')}
                </button>
                {!r.id.startsWith('ctl-') && (
                  <button className="btn sm" onClick={() => reply(r, 'always')}>
                    {t('perm.always')}
                  </button>
                )}
                <button className="btn sm danger" onClick={() => reply(r, 'reject')}>
                  {t('perm.deny')}
                </button>
              </div>
            ) : (
              <>
                {r.options && r.options.length > 0 && (
                  <div className="btns" style={{ marginBottom: 10 }}>
                    {r.options.map((o) => (
                      <button key={o} className="btn sm" onClick={() => reply(r, r.id.startsWith('ask-') ? o : [o])}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <div className="field" style={{ display: 'flex', gap: 8 }}>
                  <input className="input" placeholder={t('perm.answerPlaceholder')} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && reply(r, r.id.startsWith('ask-') ? answer : [answer])} />
                </div>
              </>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function SetupModal() {
  const { t } = useT()
  const assets = useApp((s) => s.assets)
  const progress = useApp((s) => s.progress)
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)
  const download = useApp((s) => s.downloadAssets)
  const close = useApp((s) => s.closeSetup)
  const [key, setKey] = useState(settings.apiKey)
  const [busy, setBusy] = useState(false)

  const needed = assets.filter((a) => a.required && !a.installed)
  const total = needed.reduce((n, a) => n + a.sizeMB, 0)
  const start = async () => {
    setBusy(true)
    if (key.trim() !== settings.apiKey) await patch({ apiKey: key.trim() })
    if (needed.length) await download(needed.map((a) => a.id))
    setBusy(false)
    close()
  }
  return (
    <motion.div className="modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="modal setup" initial={{ y: 30, scale: 0.96, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }}>
        <div className="hero">
          <Orb state={busy ? 'thinking' : 'idle'} size={190} accent={settings.accent} />
        </div>
        <h2 style={{ textAlign: 'center' }}>{t('setup.title')}</h2>
        <p style={{ textAlign: 'center', color: 'var(--muted)', margin: '4px 0 6px' }}>{t('setup.sub')}</p>
        <label className="field-label">{t('setup.apiKey')}</label>
        <input className="input" type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
        {needed.length > 0 && (
          <div className="list">
            {needed.map((a) => {
              const p = progress[a.id]
              const pct = p ? Math.round((p.received / (p.total || 1)) * 100) : 0
              return (
                <div className="asset" key={a.id}>
                  <div>
                    <div className="nm">{a.name}</div>
                    <small>{a.sizeMB} MB</small>
                  </div>
                  <small>{p?.phase === 'done' ? '✓' : p?.phase === 'extracting' ? 'unpacking…' : p ? pct + '%' : ''}</small>
                  {p && p.phase !== 'done' && (
                    <div className="bar">
                      <i style={{ width: pct + '%' }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button className="btn" onClick={close} disabled={busy}>
            {t('setup.skip')}
          </button>
          <button className="btn primary" onClick={start} disabled={busy}>
            <Download size={16} /> {needed.length ? `${t('setup.start')} · ${total} MB` : t('setup.start')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
