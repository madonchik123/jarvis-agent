import { ReactNode, useEffect, useState } from 'react'
import { Bot, Plug, Download, Eye, Info, Mic, SlidersHorizontal, Cpu, Volume2, X, Check } from 'lucide-react'
import type { Settings } from '@shared/types'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'
import { ProviderPanel, openUrl } from '../components/ProviderPanel'
import { ConnectorsPanel } from '../components/ConnectorsPanel'

type Tab = 'general' | 'agent' | 'connectors' | 'listening' | 'voice' | 'models' | 'about'
const TABS: { id: Tab; icon: typeof Bot; label: string; desc: string }[] = [
  { id: 'general', icon: SlidersHorizontal, label: 'st.general', desc: 'st.general.d' },
  { id: 'agent', icon: Bot, label: 'st.agent', desc: 'st.agent.d' },
  { id: 'connectors', icon: Plug, label: 'settings.connectors', desc: 'st.connectors.d' },
  { id: 'listening', icon: Mic, label: 'st.listening', desc: 'st.listening.d' },
  { id: 'voice', icon: Volume2, label: 'st.voice', desc: 'st.voice.d' },
  { id: 'models', icon: Cpu, label: 'st.models', desc: 'st.models.d' },
  { id: 'about', icon: Info, label: 'st.about', desc: 'st.about.d' }
]

const ACCENTS = ['#38d6ff', '#3df0a8', '#ffc857', '#ff7a59', '#ff5d9e', '#a58bff', '#6ea8ff', '#e8f2fc']

function Row({ label, hint, children, col, wide }: { label: string; hint?: string; children: ReactNode; col?: boolean; wide?: boolean }) {
  return (
    <div className={'row' + (col ? ' col' : '')}>
      <div className="lbl">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div className={'ctl' + (wide ? ' wide' : '')}>{children}</div>
    </div>
  )
}

function Group({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sgroup">
      {title && (
        <header>
          <h4>{title}</h4>
          {hint && <p>{hint}</p>}
        </header>
      )}
      <div className="sbody glass">{children}</div>
    </section>
  )
}

const Switch = ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />

function Slider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const p = ((value - min) / (max - min)) * 100
  return (
    <>
      <input className="slider" type="range" min={min} max={max} step={step} value={value} style={{ ['--p' as any]: p + '%' }} onChange={(e) => onChange(Number(e.target.value))} />
      <span style={{ minWidth: 38, textAlign: 'right', color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(step < 1 ? 2 : 0)}</span>
    </>
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

function Tags({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim().toLowerCase()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="tags" style={{ justifyContent: 'flex-end' }}>
      {values.map((v) => (
        <span className="tag" key={v}>
          {v}
          <button onClick={() => onChange(values.filter((x) => x !== v))}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input value={draft} placeholder="+ phrase" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
    </div>
  )
}

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false)
  return (
    <button
      className="btn"
      style={{ minWidth: 190, justifyContent: 'center', borderColor: rec ? 'var(--accent)' : undefined }}
      onClick={() => setRec(true)}
      onKeyDown={(e) => {
        if (!rec) return
        e.preventDefault()
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
        const parts = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
        const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
        if (!parts.length && !/^F\d+$/.test(key)) return
        onChange([...parts, key].join('+'))
        setRec(false)
      }}
      onBlur={() => setRec(false)}
    >
      {rec ? 'Press keys…' : value.replace('Control', 'Ctrl') || '—'}
    </button>
  )
}

export function SettingsPage() {
  const { t } = useT()
  const s = useApp((x) => x.settings)
  const patch = useApp((x) => x.patchSettings)
  const models = useApp((x) => x.models)
  const assets = useApp((x) => x.assets)
  const progress = useApp((x) => x.progress)
  const fetchModels = useApp((x) => x.fetchModels)
  const download = useApp((x) => x.downloadAssets)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [keyDraft, setKeyDraft] = useState(s.apiKey)
  const [fetching, setFetching] = useState(false)
  const [ocr, setOcr] = useState('')
  const [extra, setExtra] = useState<{ id: string; name: string; lang: 'ru' | 'en' | 'both' }[]>([])
  const [info, setInfo] = useState<any>(null)

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((st) => st.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .finally(() => navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput'))))
    api.invoke('ocr:langs').then((l: string) => setOcr(l || ''))
    api.invoke('app:info').then((i: any) => setInfo(i))
  }, [])
  useEffect(() => setKeyDraft(s.apiKey), [s.apiKey])
  useEffect(() => {
    api.invoke('voice:extra').then((v: any) => setExtra(v ?? []))
  }, [s.fishApiKey, s.fishVoiceRu, s.fishVoiceEn])

  const voices = assets.filter((a) => a.kind === 'tts' && a.id !== 'piper-runtime' && a.installed)
  const ruVoices = voices.filter((v) => v.id.startsWith('ru_') || v.id.includes('-ru'))
  const enVoices = voices.filter((v) => v.id.startsWith('jarvis'))
  const preview = (voice: string, text: string) => api.invoke('voice:preview', text, voice)

  const modelList = models.length ? models : []
  const has = (id: string) => modelList.some((m) => m.id === id)

  const [tab, setTabState] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem('jarvis.settingsTab') as Tab | null
      return v && TABS.some((x) => x.id === v) ? v : 'general'
    } catch {
      return 'general'
    }
  })
  const setTab = (v: Tab) => {
    setTabState(v)
    try {
      localStorage.setItem('jarvis.settingsTab', v)
    } catch {}
  }
  const cur = TABS.find((x) => x.id === tab)!
  const engine = s.voiceRu.startsWith('fish:') ? 'fish' : s.voiceRu.startsWith('xtts:') ? 'clone' : 'piper'

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('settings.title')}</h1>
        </div>
      </div>
      <div className="settings-shell">
        <nav className="subnav">
          {TABS.map(({ id, icon: Icon, label }) => (
            <button key={id} className={'subnav-item' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
              <Icon size={16} />
              <span>{t(label)}</span>
            </button>
          ))}
        </nav>

        <div className="scroll settings-pane" key={tab}>
          <div className="pane-inner">
            <header className="pane-head">
              <h2>{t(cur.label)}</h2>
              <p>{t(cur.desc)}</p>
            </header>

            {tab === 'general' && (
              <>
                <Group title={t('sg.look')}>
                  <Row label={t('settings.accent')}>
                    <div className="swatches">
                      {ACCENTS.map((c) => (
                        <button key={c} className={'swatch' + (s.accent === c ? ' on' : '')} style={{ ['--c' as any]: c }} onClick={() => patch({ accent: c })} />
                      ))}
                    </div>
                  </Row>
                  <Row label={t('settings.theme')}>
                    <Seg value={s.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'Auto']]} onChange={(v) => patch({ theme: v })} />
                  </Row>
                  <Row label={t('settings.language')}>
                    <Seg value={s.interfaceLang} options={[['auto', 'Auto'], ['ru', 'RU'], ['en', 'EN']]} onChange={(v) => patch({ interfaceLang: v })} />
                  </Row>
                </Group>
                <Group title={t('sg.startup')}>
                  <Row label={t('settings.hud')}>
                    <Seg value={s.hudCorner} options={[['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘']]} onChange={(v) => patch({ hudCorner: v })} />
                  </Row>
                  <Row label={t('settings.subtitles')}>
                    <Switch on={s.showSubtitles} onChange={(v) => patch({ showSubtitles: v })} />
                  </Row>
                  <Row label={t('settings.autostart')}>
                    <Switch on={s.autoStart} onChange={(v) => patch({ autoStart: v })} />
                  </Row>
                  <Row label={t('settings.startMin')}>
                    <Switch on={s.startMinimized} onChange={(v) => patch({ startMinimized: v })} />
                  </Row>
                </Group>
              </>
            )}

            {tab === 'agent' && (
              <>
                <Group title={t('sg.model')}>
                  <ProviderPanel />
                  <Row label={t('settings.vision')} hint={t('settings.visionHint')} col>
                    <select className="select" value={s.visionModel === 'opencode/nemotron-3.5-super-vl-free' ? 'auto' : s.visionModel} onChange={(e) => patch({ visionModel: e.target.value })}>
                      <option value="auto">{t('settings.visionAuto')}</option>
                      {s.visionModel !== 'auto' && !modelList.some((m) => m.id === s.visionModel) && <option value={s.visionModel}>{s.visionModel}</option>}
                      {modelList
                        .filter((m) => m.vision || m.id === 'opencode/nemotron-3.5-super-vl-free')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.free ? ' · free' : ''}
                          </option>
                        ))}
                    </select>
                  </Row>
                </Group>
                <Group title={t('sg.behavior')}>
                  <Row label={t('settings.permissions')} col>
                    <Seg
                      value={s.permissionMode}
                      options={[
                        ['ask', t('settings.perm.ask')],
                        ['safe-auto', t('settings.perm.safe')],
                        ['full-auto', t('settings.perm.full')]
                      ]}
                      onChange={(v) => patch({ permissionMode: v })}
                    />
                  </Row>
                  <Row label={t('settings.autoNew')} hint={t('settings.autoNewHint')}>
                    <Slider value={s.autoNewThreadMinutes} min={0} max={180} step={5} onChange={(v) => patch({ autoNewThreadMinutes: v })} />
                  </Row>
                  <Row label={t('settings.cwd')}>
                    <input className="input" placeholder="C:\Users\you" defaultValue={s.cwd} onBlur={(e) => patch({ cwd: e.target.value })} />
                  </Row>
                </Group>
                <Group title={t('sg.instructions')}>
                  <Row label={t('settings.custom')} hint={t('settings.customHint')} col>
                    <textarea className="textarea" defaultValue={s.customSystemPrompt} onBlur={(e) => patch({ customSystemPrompt: e.target.value })} />
                  </Row>
                </Group>
              </>
            )}

            {tab === 'connectors' && (
              <Group>
                <ConnectorsPanel />
              </Group>
            )}

            {tab === 'listening' && (
              <>
                <Group title={t('sg.wake')}>
                  <Row label={t('settings.wakeEnabled')}>
                    <Switch on={s.wakeEnabled} onChange={(v) => patch({ wakeEnabled: v })} />
                  </Row>
                  <Row label={t('settings.wakePhrases')} col>
                    <Tags values={s.wakePhrases} onChange={(v) => patch({ wakePhrases: v })} />
                  </Row>
                  <Row label={t('settings.wakeSens')}>
                    <Slider value={s.wakeSensitivity} min={0.1} max={1} step={0.05} onChange={(v) => patch({ wakeSensitivity: v })} />
                  </Row>
                  <Row label={t('settings.ack')} hint={t('settings.ackHint')}>
                    <Seg
                      value={s.wakeAck}
                      options={[
                        ['always', t('settings.ack.always')],
                        ['wake-only', t('settings.ack.wake')],
                        ['off', t('settings.ack.off')]
                      ]}
                      onChange={(v) => patch({ wakeAck: v })}
                    />
                  </Row>
                  <Row label={t('settings.listenWindow')} hint={t('settings.listenWindowHint')}>
                    <Slider value={s.followupSeconds} min={3} max={15} step={1} onChange={(v) => patch({ followupSeconds: v })} />
                  </Row>
                </Group>
                <Group title={t('sg.recognition')}>
                  <Row label={t('settings.mic')}>
                    <select className="select" value={s.micDeviceId} onChange={(e) => patch({ micDeviceId: e.target.value })}>
                      <option value="default">System default</option>
                      {mics.map((m) => (
                        <option key={m.deviceId} value={m.deviceId}>
                          {m.label || m.deviceId.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label={t('settings.stt')}>
                    <Seg value={s.sttModel} options={[['parakeet-en', 'Parakeet'], ['whisper-base', 'Whisper base'], ['whisper-small', 'small'], ['whisper-turbo', 'turbo']]} onChange={(v) => patch({ sttModel: v })} />
                  </Row>
                  <Row label={t('settings.sttLang')}>
                    <Seg value={s.sttLanguage} options={[['auto', 'Auto'], ['ru', 'RU'], ['en', 'EN']]} onChange={(v) => patch({ sttLanguage: v })} />
                  </Row>
                </Group>
                <Group title={t('sg.shortcut')}>
                  <Row label={t('settings.hotkey')}>
                    <HotkeyInput value={s.hotkey} onChange={(v) => patch({ hotkey: v })} />
                  </Row>
                </Group>
              </>
            )}

            {tab === 'voice' && (
              <>
                <Group title={t('sg.engine')}>
                  <Row label={t('settings.voiceEngine')}>
                    <Seg
                      value={engine}
                      options={[
                        ['fish', t('settings.engine.fish')],
                        ['piper', t('settings.engine.piper')],
                        ['clone', t('settings.engine.clone')]
                      ]}
                      onChange={(v) => {
                        if (v === 'fish') patch({ voiceRu: 'fish:ru', voiceEn: 'fish:en' })
                        else if (v === 'clone') patch({ voiceRu: 'xtts:jarvis', voiceEn: 'xtts:jarvis' })
                        else patch({ voiceRu: 'ru_RU-denis-medium', voiceEn: 'jarvis-high' })
                      }}
                    />
                  </Row>
                  <Row label={t('settings.voiceEnabled')}>
                    <Switch on={s.voiceEnabled} onChange={(v) => patch({ voiceEnabled: v })} />
                  </Row>
                </Group>

                {!s.fishApiKey ? (
                  <Group title={t('sg.fishCreds')} hint={t('settings.fishHint')}>
                    <Row label={t('settings.fishKey')} col>
                      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                        <input className="input" type="password" placeholder="sk-fish-…" defaultValue={s.fishApiKey} onBlur={(e) => e.target.value.trim() !== s.fishApiKey && patch({ fishApiKey: e.target.value.trim() })} />
                        <button className="btn" onClick={() => openUrl('https://fish.audio/app/api-keys')}>
                          {t('settings.fishGetKey')} ↗
                        </button>
                      </div>
                    </Row>
                    <Row label={t('settings.fishModel')}>
                      <input className="input" defaultValue={s.fishModel} onBlur={(e) => patch({ fishModel: e.target.value.trim() || 's2.1-pro-free' })} />
                    </Row>
                    <Row label={t('settings.fishRu')}>
                      <input className="input" defaultValue={s.fishVoiceRu} placeholder="reference_id" onBlur={(e) => patch({ fishVoiceRu: e.target.value.trim() })} />
                    </Row>
                    <Row label={t('settings.fishEn')}>
                      <input className="input" defaultValue={s.fishVoiceEn} placeholder="reference_id" onBlur={(e) => patch({ fishVoiceEn: e.target.value.trim() })} />
                    </Row>
                  </Group>
                ) : (
                  <details className="fold">
                    <summary>{t('sg.fishCreds')}</summary>
                    <Group>
                      <Row label={t('settings.fishKey')} col>
                        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                          <input className="input" type="password" placeholder="sk-fish-…" defaultValue={s.fishApiKey} onBlur={(e) => e.target.value.trim() !== s.fishApiKey && patch({ fishApiKey: e.target.value.trim() })} />
                          <button className="btn" onClick={() => openUrl('https://fish.audio/app/api-keys')}>
                            {t('settings.fishGetKey')} ↗
                          </button>
                        </div>
                      </Row>
                      <Row label={t('settings.fishModel')}>
                        <input className="input" defaultValue={s.fishModel} onBlur={(e) => patch({ fishModel: e.target.value.trim() || 's2.1-pro-free' })} />
                      </Row>
                      <Row label={t('settings.fishRu')}>
                        <input className="input" defaultValue={s.fishVoiceRu} placeholder="reference_id" onBlur={(e) => patch({ fishVoiceRu: e.target.value.trim() })} />
                      </Row>
                      <Row label={t('settings.fishEn')}>
                        <input className="input" defaultValue={s.fishVoiceEn} placeholder="reference_id" onBlur={(e) => patch({ fishVoiceEn: e.target.value.trim() })} />
                      </Row>
                    </Group>
                  </details>
                )}

                <Group title={t('sg.voices')}>
                  <Row label={t('settings.voiceRu')}>
                    <select className="select" value={s.voiceRu} onChange={(e) => patch({ voiceRu: e.target.value })}>
                      {extra.filter((v) => v.lang !== 'en').map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                      {ruVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <button className="btn sm" onClick={() => preview(s.voiceRu, 'Добрый день, сэр. Все системы работают в штатном режиме.')}>
                      {t('settings.preview')}
                    </button>
                  </Row>
                  <Row label={t('settings.voiceEn')}>
                    <select className="select" value={s.voiceEn} onChange={(e) => patch({ voiceEn: e.target.value })}>
                      {extra.filter((v) => v.lang !== 'ru').map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                      {enVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <button className="btn sm" onClick={() => preview(s.voiceEn, 'Good evening, sir. All systems are running at full capacity.')}>
                      {t('settings.preview')}
                    </button>
                  </Row>
                </Group>

                <Group title={t('sg.playback')}>
                  <Row label={t('settings.speed')}>
                    <Slider value={s.voiceSpeed} min={0.7} max={1.5} step={0.05} onChange={(v) => patch({ voiceSpeed: v })} />
                  </Row>
                  <Row label={t('settings.volume')}>
                    <Slider value={s.voiceVolume} min={0} max={1} step={0.05} onChange={(v) => patch({ voiceVolume: v })} />
                  </Row>
                  <Row label={t('settings.fx')}>
                    <Switch on={s.voiceFx} onChange={(v) => patch({ voiceFx: v })} />
                  </Row>
                  {extra.some((v) => v.id.startsWith('xtts')) && (
                    <Row label={t('settings.cloneIdle')} hint={t('settings.cloneIdleHint')}>
                      <Slider value={s.cloneIdleMinutes} min={0} max={60} step={5} onChange={(v) => patch({ cloneIdleMinutes: v })} />
                    </Row>
                  )}
                </Group>
              </>
            )}

            {tab === 'models' && (
              <Group>
                {assets.map((a) => {
                  const p = progress[a.id]
                  const active = p && (p.phase === 'downloading' || p.phase === 'extracting')
                  return (
                    <div className="asset" key={a.id}>
                      <div>
                        <div className="nm">
                          <b style={{ fontWeight: 500 }}>{a.name}</b>
                          {a.required && <span className="chip">core</span>}
                        </div>
                        <small>
                          {a.sizeMB} MB {a.note ? '· ' + a.note : ''}
                          {p?.phase === 'error' ? ' · ' + p.error : ''}
                        </small>
                      </div>
                      {a.installed ? (
                        <span className="chip ok">
                          <Check size={12} /> {t('settings.installed')}
                        </span>
                      ) : (
                        <button className="btn sm" disabled={!!active} onClick={() => download([a.id])}>
                          <Download size={14} /> {active ? (p.phase === 'extracting' ? '…' : Math.round((p.received / (p.total || 1)) * 100) + '%') : t('settings.install')}
                        </button>
                      )}
                      {active && (
                        <div className="bar">
                          <i style={{ width: `${Math.round((p.received / (p.total || 1)) * 100)}%` }} />
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="asset">
                  <div>
                    <div className="nm">
                      <Eye size={15} /> <b style={{ fontWeight: 500 }}>{t('settings.ocr')}</b>
                    </div>
                    <small>
                      Windows OCR languages: {ocr || '—'}
                      {!ocr.includes('ru') ? ' · Russian missing: Settings → Time & language → Language → Add Russian' : ''}
                    </small>
                  </div>
                </div>
              </Group>
            )}

            {tab === 'about' && (
              <Group>
                {info && (
                  <div className="about">
                    <div>
                      <b>Jarvis</b> {info.version} · Electron {info.electron} · {info.platform}
                    </div>
                    <div>
                      Agent: {info.status?.opencode} · speech: {info.status?.speech} · voice engine: {info.status?.clone ?? 'off'} · recogniser: {info.asrLoaded ? 'loaded' : 'idle (unloaded)'}
                    </div>
                    <div>
                      Model: {info.model} · main process {info.mainRssMB} MB
                    </div>
                    <div style={{ wordBreak: 'break-all' }}>Data: {info.dataDir}</div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, padding: '4px 18px 16px', flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => api.invoke('app:openLogs')}>
                    {t('settings.openLogs')}
                  </button>
                  <button className="btn sm" onClick={() => info && navigator.clipboard.writeText(JSON.stringify(info, null, 2))}>
                    {t('settings.copyDiag')}
                  </button>
                </div>
              </Group>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
