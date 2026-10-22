import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, Link2Off, RefreshCw, Search } from 'lucide-react'
import type { ProviderInfo } from '@shared/types'
import { api } from '../api'
import { useApp, useT } from '../store'

/** Where each popular provider hands out API keys. */
export const KEY_URLS: Record<string, string> = {
  opencode: 'https://opencode.ai/auth',
  openrouter: 'https://openrouter.ai/keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai/api-keys',
  togetherai: 'https://api.together.ai/settings/api-keys',
  'fireworks-ai': 'https://fireworks.ai/account/api-keys',
  cerebras: 'https://cloud.cerebras.ai',
  perplexity: 'https://www.perplexity.ai/settings/api',
  nvidia: 'https://build.nvidia.com/settings/api-keys',
  deepinfra: 'https://deepinfra.com/dash/api_keys'
}
const POPULAR = ['opencode', 'openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'groq', 'xai', 'mistral', 'togetherai', 'cerebras']
const CUSTOM = '__custom'

export const openUrl = (url: string) => api.invoke('app:openUrl', url)

export function ProviderPanel() {
  const { t } = useT()
  const s = useApp((x) => x.settings)
  const patch = useApp((x) => x.patchSettings)
  const models = useApp((x) => x.models)
  const fetchModels = useApp((x) => x.fetchModels)
  const agentStatus = useApp((x) => x.status.opencode)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [selected, setSelected] = useState(s.customProvider.enabled && s.model.startsWith('custom/') ? CUSTOM : s.model.split('/')[0])
  const [search, setSearch] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState('')
  const [msg, setMsg] = useState('')
  const cp = s.customProvider

  const load = async () => {
    const list: ProviderInfo[] = (await api.invoke('providers:list')) ?? []
    setProviders(list)
    await fetchModels(true)
  }
  // the provider catalogue comes from the agent: (re)load whenever it becomes ready
  useEffect(() => {
    if (agentStatus === 'ready') void load()
  }, [agentStatus])

  const byId = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])
  const current = byId.get(selected)
  const connected = selected === CUSTOM ? cp.enabled : !!current?.connected
  const providerModels = models.filter((m) => m.provider === selected)

  const options = useMemo(() => {
    const q = search.trim().toLowerCase()
    const match = (p: ProviderInfo) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    const pop = POPULAR.map((id) => byId.get(id)).filter((p): p is ProviderInfo => !!p && match(p))
    const rest = providers.filter((p) => !POPULAR.includes(p.id) && match(p)).sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
    return { pop, rest }
  }, [providers, byId, search])

  const connect = async () => {
    if (!key.trim()) return
    setBusy(true)
    setMsg('')
    try {
      await api.invoke('providers:connect', selected, key.trim())
      if (selected === 'opencode') await patch({ apiKey: key.trim() })
      setKey('')
      await load()
      setMsg(t('prov.connected'))
    } catch (e: any) {
      setMsg(String(e?.message || e))
    }
    setBusy(false)
  }

  const disconnect = async () => {
    setBusy(true)
    await api.invoke('providers:disconnect', selected)
    if (selected === 'opencode') await patch({ apiKey: '' })
    await load()
    setBusy(false)
  }

  const useModel = (id: string) => patch({ model: id })

  return (
    <div className="prov">
      <div className="row col">
        <div className="lbl">
          <b>{t('prov.provider')}</b>
          <small>{t('prov.providerHint')}</small>
        </div>
        <div className="ctl" style={{ gap: 8 }}>
          <div className="searchbox">
            <Search size={14} />
            <input placeholder={t('prov.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="select" value={selected} onChange={(e) => (setSelected(e.target.value), setMsg(''))}>
            {providers.length === 0 && <option value={selected}>{selected} …</option>}
            <optgroup label={t('prov.popular')}>
              {options.pop.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.connected ? ' ✓' : ''}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('prov.custom')}>
              <option value={CUSTOM}>{t('prov.customEndpoint')}</option>
            </optgroup>
            {options.rest.length > 0 && (
              <optgroup label={t('prov.all')}>
                {options.rest.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.connected ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      {selected === CUSTOM ? (
        <>
          <div className="row col">
            <div className="lbl">
              <b>{t('prov.baseUrl')}</b>
              <small>{t('prov.customHint')}</small>
            </div>
            <div className="ctl">
              <input className="input" placeholder="https://api.example.com/v1" defaultValue={cp.baseURL} onBlur={(e) => patch({ customProvider: { ...cp, baseURL: e.target.value.trim() } })} />
            </div>
          </div>
          <div className="row col">
            <div className="lbl">
              <b>{t('prov.apiKey')}</b>
            </div>
            <div className="ctl">
              <input className="input" type="password" placeholder="sk-…" defaultValue={cp.apiKey} onBlur={(e) => patch({ customProvider: { ...cp, apiKey: e.target.value.trim() } })} />
            </div>
          </div>
          <div className="row col">
            <div className="lbl">
              <b>{t('prov.modelIds')}</b>
              <small>{t('prov.modelIdsHint')}</small>
            </div>
            <div className="ctl">
              <input className="input" placeholder="gpt-4o-mini, llama-3.3-70b" defaultValue={cp.models} onBlur={(e) => patch({ customProvider: { ...cp, models: e.target.value } })} />
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn primary"
              disabled={!cp.baseURL || !cp.models.trim()}
              onClick={async () => {
                const first = cp.models.split(',')[0].trim()
                await patch({ customProvider: { ...cp, enabled: true }, model: `custom/${first}` })
                setMsg(t('prov.restarting'))
              }}
            >
              {t('prov.saveUse')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row col">
            <div className="lbl">
              <b>{t('prov.apiKey')}</b>
              {current?.env?.[0] && <small>{current.env[0]}</small>}
            </div>
            <div className="ctl" style={{ gap: 8 }}>
              {connected ? (
                <>
                  <span className="chip ok">
                    <Check size={12} /> {t('prov.connected')}
                  </span>
                  {selected !== 'opencode' && (
                    <button className="btn sm" disabled={busy} onClick={disconnect}>
                      <Link2Off size={14} /> {t('prov.disconnect')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <input className="input" type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && connect()} />
                  <button className="btn primary" disabled={busy || !key.trim()} onClick={connect}>
                    {t('prov.connect')}
                  </button>
                </>
              )}
              {KEY_URLS[selected] && (
                <button className="btn sm" onClick={() => openUrl(KEY_URLS[selected])}>
                  <ExternalLink size={14} /> {t('prov.getKey')}
                </button>
              )}
            </div>
            {selected === 'opencode' && <small style={{ color: 'var(--muted)' }}>{t('settings.apiKeyHint')}</small>}
            {msg && <small style={{ color: 'var(--accent)' }}>{msg}</small>}
          </div>

          <div className="row col">
            <div className="lbl">
              <b>{t('settings.model')}</b>
            </div>
            <div className="ctl" style={{ gap: 8 }}>
              <select className="select" value={providerModels.some((m) => m.id === s.model) ? s.model : ''} onChange={(e) => e.target.value && useModel(e.target.value)} disabled={!connected}>
                <option value="">{connected ? (providerModels.length ? t('prov.pickModel') : t('prov.noModels')) : t('prov.connectFirst')}</option>
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.free ? ' · free' : ''}
                    {m.vision ? ' · vision' : ''}
                  </option>
                ))}
              </select>
              <button className="btn sm" title={t('settings.fetchModels')} onClick={() => void load()}>
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="ctl" style={{ gap: 8 }}>
              <input className="input" placeholder={t('prov.manualModel')} value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && manual.trim() && (useModel(`${selected}/${manual.trim()}`), setManual(''))} disabled={!connected} />
              <button className="btn sm" disabled={!connected || !manual.trim()} onClick={() => (useModel(`${selected}/${manual.trim()}`), setManual(''))}>
                {t('prov.use')}
              </button>
            </div>
            <small style={{ color: 'var(--muted)' }}>
              {t('prov.active')}: <b>{s.model}</b>
            </small>
          </div>
        </>
      )}
    </div>
  )
}
