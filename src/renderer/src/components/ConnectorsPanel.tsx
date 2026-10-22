import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ExternalLink, LogIn, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { ConnectorConfig, ConnectorStatus } from '@shared/types'
import { CATEGORY_LABEL, PRESETS, connectorId, fromPreset, type ConnectorPreset, type PresetCategory } from '@shared/connectors'
import { api } from '../api'
import { useApp, useT } from '../store'
import { openUrl } from './ProviderPanel'

type Status = Record<string, ConnectorStatus>

const L = (pair: [string, string], locale: string) => (locale === 'ru' ? pair[0] : pair[1])

/** Settings → Connectors: plug MCP servers (Gmail, Calendar, Notion, GitHub, …) into the agent. */
export function ConnectorsPanel() {
  const { t, locale } = useT()
  const connectors = useApp((x) => x.settings.connectors ?? [])
  const agent = useApp((x) => x.status.opencode)
  const patch = useApp((x) => x.patchSettings)
  const [status, setStatus] = useState<Status>({})
  const [busy, setBusy] = useState<string>('')
  const [msg, setMsg] = useState('')
  const [adding, setAdding] = useState<ConnectorPreset | 'custom' | null>(null)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<PresetCategory | 'all'>('all')

  const refresh = async () => setStatus((await api.invoke('connectors:status')) ?? {})
  // the agent restarts when connectors change: poll until the servers have settled
  useEffect(() => {
    if (agent !== 'ready') return
    void refresh()
    const id = setInterval(() => void refresh(), 4000)
    return () => clearInterval(id)
  }, [agent, connectors.length])

  const save = (next: ConnectorConfig[]) => patch({ connectors: next })
  const remove = (c: ConnectorConfig) => save(connectors.filter((x) => x.id !== c.id))
  const toggle = (c: ConnectorConfig) => save(connectors.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)))

  const signIn = async (c: ConnectorConfig) => {
    setBusy(c.id)
    setMsg(t('conn.signingIn'))
    try {
      const r: ConnectorStatus = await api.invoke('connectors:auth', c.id)
      setMsg(r.status === 'connected' ? t('conn.signedIn') : r.error || r.status)
    } catch (e: any) {
      setMsg(String(e?.message || e).replace(/^Error invoking remote method '[^']+': /, ''))
    }
    setBusy('')
    void refresh()
  }
  const reconnect = async (c: ConnectorConfig) => {
    setBusy(c.id)
    try {
      setStatus((await api.invoke('connectors:reconnect', c.id)) ?? {})
    } catch (e: any) {
      setMsg(String(e?.message || e))
    }
    setBusy('')
  }

  const label = (c: ConnectorConfig) => {
    const s = status[c.id]
    if (!c.enabled) return { cls: '', text: t('conn.off') }
    if (agent !== 'ready' || !s) return { cls: '', text: t('conn.starting') }
    if (s.status === 'connected') return { cls: 'ok', text: t('conn.connected') }
    if (s.status === 'needs_auth') return { cls: 'warn', text: t('conn.needsAuth') }
    if (s.status === 'needs_client_registration') return { cls: 'warn', text: t('conn.needsClient') }
    if (s.status === 'failed') return { cls: 'bad', text: t('conn.failed') }
    return { cls: '', text: s.status }
  }

  const presets = useMemo(() => {
    const n = q.trim().toLowerCase()
    return PRESETS.filter((p) => (cat === 'all' || p.category === cat) && (!n || p.name.toLowerCase().includes(n) || L(p.desc, locale).toLowerCase().includes(n))).filter((p) => !connectors.some((c) => c.preset === p.id))
  }, [q, cat, connectors, locale])

  return (
    <div className="prov conn">
      <div className="row col">
        <div className="lbl">
          <b>{t('conn.title')}</b>
          <small>{t('conn.hint')}</small>
        </div>
      </div>

      {connectors.length === 0 && <div className="thread-empty">{t('conn.empty')}</div>}
      {connectors.map((c) => {
        const l = label(c)
        const s = status[c.id]
        return (
          <div className="conn-item" key={c.id}>
            <div className="conn-head">
              <div className="conn-name">
                <b>{c.name}</b>
                <code>{c.id}_*</code>
              </div>
              <span className={'chip ' + l.cls}>
                <span className="dot" /> {l.text}
              </span>
            </div>
            {s?.error && c.enabled && s.status !== 'connected' && (
              <small className="conn-err">
                <AlertTriangle size={12} /> {s.error.slice(0, 220)}
              </small>
            )}
            <div className="conn-actions">
              {c.enabled && c.type === 'remote' && !c.noOAuth && (s?.status === 'needs_auth' || s?.status === 'needs_client_registration' || s?.status === 'failed') && (
                <button className="btn sm primary" disabled={!!busy} onClick={() => signIn(c)}>
                  <LogIn size={14} /> {t('conn.signIn')}
                </button>
              )}
              {c.enabled && (
                <button className="btn sm" disabled={!!busy} onClick={() => reconnect(c)} title={t('conn.reconnect')}>
                  <RefreshCw size={14} />
                </button>
              )}
              <button className="btn sm" onClick={() => toggle(c)}>
                {c.enabled ? t('conn.disable') : t('conn.enable')}
              </button>
              <button className="btn sm danger" onClick={() => remove(c)} title={t('conn.remove')}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )
      })}
      {msg && <small style={{ color: 'var(--accent)' }}>{msg}</small>}

      {!adding && (
        <>
          <div className="row col">
            <div className="lbl">
              <b>{t('conn.add')}</b>
            </div>
            <div className="ctl" style={{ gap: 8, flexWrap: 'wrap' }}>
              <div className="searchbox" style={{ flex: '1 1 180px' }}>
                <Search size={14} />
                <input placeholder={t('conn.search')} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <select className="select" value={cat} onChange={(e) => setCat(e.target.value as PresetCategory | 'all')} style={{ flex: '0 0 auto', width: 'auto' }}>
                <option value="all">{t('conn.all')}</option>
                {(Object.keys(CATEGORY_LABEL) as PresetCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {L(CATEGORY_LABEL[k], locale)}
                  </option>
                ))}
              </select>
              <button className="btn sm" onClick={() => setAdding('custom')}>
                <Plus size={14} /> {t('conn.custom')}
              </button>
            </div>
          </div>
          <div className="conn-grid">
            {presets.map((p) => (
              <button key={p.id} className="conn-card" onClick={() => setAdding(p)}>
                <b>{p.name}</b>
                <small>{L(p.desc, locale)}</small>
                <span className="conn-tags">
                  {!p.fields?.length && p.type === 'remote' && <i>{t('conn.tagLogin')}</i>}
                  {p.fields?.some((f) => !f.optional) && <i>{t('conn.tagKey')}</i>}
                  {p.type === 'local' && <i>{p.needs === 'uv' ? 'uv' : 'Node.js'}</i>}
                </span>
              </button>
            ))}
            {presets.length === 0 && <div className="thread-empty">{t('conn.nothing')}</div>}
          </div>
        </>
      )}

      {adding && (
        <AddForm
          preset={adding}
          existing={connectors}
          onCancel={() => setAdding(null)}
          onAdd={async (c) => {
            await save([...connectors, c])
            setAdding(null)
            setMsg(t('conn.added'))
          }}
        />
      )}
    </div>
  )
}

function AddForm({ preset, existing, onCancel, onAdd }: { preset: ConnectorPreset | 'custom'; existing: ConnectorConfig[]; onCancel: () => void; onAdd: (c: ConnectorConfig) => void }) {
  const { t, locale } = useT()
  const custom = preset === 'custom'
  const p = custom ? null : preset
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((p?.fields ?? []).filter((f) => f.value).map((f) => [f.key, f.value!])))
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'remote' | 'local'>('remote')
  const [url, setUrl] = useState('')
  const [cmd, setCmd] = useState('')
  const [extra, setExtra] = useState('') // KEY=value lines: headers (remote) or env (local)
  const missing = p ? (p.fields ?? []).some((f) => !f.optional && !(vals[f.key] ?? '').trim()) : !name.trim() || (kind === 'remote' ? !/^https?:\/\//.test(url.trim()) : !cmd.trim())

  const submit = () => {
    let c: ConnectorConfig
    if (p) c = fromPreset(p, vals)
    else {
      const kv: Record<string, string> = {}
      for (const line of extra.split('\n')) {
        const i = line.indexOf(kind === 'remote' ? ':' : '=')
        if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      c = { id: connectorId(name), name: name.trim(), type: kind, url: kind === 'remote' ? url.trim() : undefined, command: kind === 'local' ? cmd.trim() : undefined, headers: kind === 'remote' ? kv : {}, env: kind === 'local' ? kv : {}, noOAuth: kind === 'remote' && Object.keys(kv).length > 0, enabled: true }
    }
    // unique tool prefix
    let id = c.id
    for (let n = 2; existing.some((x) => x.id === id); n++) id = `${c.id}_${n}`
    onAdd({ ...c, id })
  }

  return (
    <div className="conn-form">
      <div className="conn-head">
        <b>{p ? p.name : t('conn.custom')}</b>
        <button className="btn sm" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      {p && <small style={{ color: 'var(--muted)' }}>{L(p.desc, locale)}</small>}
      {p?.note && <small className="conn-note">{L(p.note, locale)}</small>}
      {p?.needs && <small className="conn-note">{p.needs === 'uv' ? t('conn.needsUv') : t('conn.needsNode')}</small>}

      {custom && (
        <>
          <input className="input" placeholder={t('conn.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="seg">
            {(['remote', 'local'] as const).map((k) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'remote' ? t('conn.remote') : t('conn.local')}
              </button>
            ))}
          </div>
          {kind === 'remote' ? <input className="input" placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /> : <input className="input" placeholder="npx -y @scope/mcp-server" value={cmd} onChange={(e) => setCmd(e.target.value)} />}
          <textarea className="input" rows={3} placeholder={kind === 'remote' ? 'Authorization: Bearer sk-…' : 'API_KEY=…'} value={extra} onChange={(e) => setExtra(e.target.value)} />
          <small style={{ color: 'var(--muted)' }}>{kind === 'remote' ? t('conn.customRemoteHint') : t('conn.customLocalHint')}</small>
        </>
      )}

      {p?.fields?.map((f) => (
        <label key={f.key} className="conn-field">
          <span>
            {L(f.label, locale)}
            {f.optional ? ` · ${t('conn.optional')}` : ''}
          </span>
          <input className="input" type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
        </label>
      ))}

      <div className="conn-actions">
        {p?.keyUrl && (
          <button className="btn sm" onClick={() => openUrl(p.keyUrl!)}>
            <ExternalLink size={14} /> {t('conn.getCreds')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn sm primary" disabled={missing} onClick={submit}>
          <Check size={14} /> {t('conn.addBtn')}
        </button>
      </div>
    </div>
  )
}
