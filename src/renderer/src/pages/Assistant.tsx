import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Check, ChevronDown, History, MessageSquarePlus, Pencil, Trash2, Eye, FileText, Globe, Keyboard, Loader2, Mic, MousePointer2, Plus, Search, Square, Terminal, Wrench, Volume2, X, Brain, Zap, Crosshair } from 'lucide-react'
import type { AppStatus, ChatItem, ToolEvent } from '@shared/types'
import { Orb } from '../components/Orb'
import { Markdown } from '../components/Markdown'
import { PermissionStack } from '../components/Overlays'
import { api, IPC } from '../api'
import { useApp, useT } from '../store'

const TOOL_ICON: Record<string, typeof Wrench> = {
  bash: Terminal,
  read: FileText,
  write: FileText,
  edit: FileText,
  glob: Search,
  grep: Search,
  webfetch: Globe,
  websearch: Globe,
  jarvis_screenshot: Eye,
  jarvis_screen_text: Eye,
  jarvis_find_on_screen: Search,
  jarvis_ui_elements: Eye,
  jarvis_highlight: Crosshair,
  jarvis_click: MousePointer2,
  jarvis_click_element: MousePointer2,
  jarvis_type: Keyboard,
  jarvis_keys: Keyboard,
  jarvis_remember: Brain,
  jarvis_recall: Brain,
  jarvis_routine_save: Zap,
  jarvis_ask: Mic
}

function toolSummary(t: ToolEvent): string {
  const i: any = t.input || {}
  return t.title || i.command || i.filePath || i.path || i.url || i.query || i.text || i.fact || i.keys || i.name || ''
}

function ToolCard({ tool }: { tool: ToolEvent }) {
  const Icon = TOOL_ICON[tool.tool] || Wrench
  const running = tool.status === 'running' || tool.status === 'pending'
  const [open, setOpen] = useState(false)
  const { t } = useT()
  const input = tool.input && Object.keys(tool.input as object).length ? JSON.stringify(tool.input, null, 2) : ''
  return (
    <div className={'tool enter ' + (running ? 'running' : tool.status === 'error' ? 'error' : '')} onClick={() => setOpen(!open)} style={{ cursor: 'pointer', flexWrap: 'wrap' }}>
      <span className="ico">{running ? <Loader2 size={15} /> : tool.status === 'error' ? <X size={15} /> : <Check size={15} />}</span>
      <Icon size={14} style={{ opacity: 0.7 }} />
      <span className="name">{tool.tool.replace(/^jarvis_/, '')}</span>
      <span className="sub">{toolSummary(tool)}</span>
      <span style={{ color: 'var(--muted)', fontSize: 11 }}>{running ? t('tool.running') : tool.ms ? (tool.ms / 1000).toFixed(1) + 's' : tool.status === 'error' ? t('tool.failed') : ''}</span>
      {open && (
        <div className="tool-detail" onClick={(e) => e.stopPropagation()}>
          {input && (
            <>
              <small>{t('process.input')}</small>
              <pre>{input}</pre>
            </>
          )}
          {tool.output && (
            <>
              <small>{t('process.output')}</small>
              <pre>{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Long answers are shown collapsed (the gist is spoken); expand on demand. */
function Collapsible({ children, done, long }: { children: React.ReactNode; done: boolean; long: boolean }) {
  const [open, setOpen] = useState(false)
  const { t } = useT()
  const clamp = long && !open
  return (
    <>
      <div className={'clamp' + (clamp ? ' on' : '')}>{children}</div>
      {long && done && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? t('chat.showLess') : t('chat.showMore')}
        </button>
      )}
    </>
  )
}

function ThinkingPill({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false)
  const { t } = useT()
  if (!item.text.trim()) return null
  return (
    <div className={'think enter' + (item.done ? '' : ' live')}>
      <button onClick={() => setOpen(!open)}>
        <Brain size={13} />
        <span>{t('chat.thinking')}</span>
        {item.ms ? <em>{(item.ms / 1000).toFixed(1)}s</em> : !item.done ? <em className="dots">…</em> : null}
        <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
      </button>
      {open && <div className="think-body">{item.text}</div>}
    </div>
  )
}

function Message({ item }: { item: ChatItem }) {
  const { t } = useT()
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user enter">
          {item.via === 'voice' && <div className="via">🎙 voice</div>}
          {item.text}
        </div>
      )
    case 'assistant':
      if (!item.text.trim()) return null
      return (
        <div className="msg assistant enter">
          <Collapsible done={item.done} long={item.text.length > 360 || item.text.split('\n').length > 7}>
            <Markdown text={item.text} />
          </Collapsible>
          {!item.done && <span className="caret" />}
        </div>
      )
    case 'say':
      return (
        <div className="msg say enter">
          <span className="wave">
            {[0, 0.15, 0.3, 0.1, 0.25].map((d, i) => (
              <i key={i} style={{ animationDelay: `${d}s` }} />
            ))}
          </span>
          <Volume2 size={14} />
          <span>{item.text}</span>
        </div>
      )
    case 'tool':
      return <ToolCard tool={item.tool} />
    case 'thinking':
      return <ThinkingPill item={item} />
    case 'system':
      return (
        <div className="msg system enter">
          {item.text}
        </div>
      )
  }
  void t
}

function relTime(ts: number, locale: string) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return locale === 'ru' ? 'сейчас' : 'now'
  if (m < 60) return locale === 'ru' ? `${m} мин` : `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return locale === 'ru' ? `${h} ч` : `${h}h`
  return new Date(ts).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' })
}

function ThreadBar({ onProcess }: { onProcess: () => void }) {
  const { t, locale } = useT()
  const ts = useApp((s) => s.threads)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const cur = ts.threads.find((x) => x.id === ts.currentId)
  const title = cur?.title || t('threads.newTitle')
  return (
    <>
      <div className="thread-bar">
        <button className="icon-btn" title={t('threads.history')} onClick={() => setOpen(!open)} style={open ? { color: 'var(--accent)' } : undefined}>
          <History size={18} />
        </button>
        <div className="thread-title" title={title}>
          {title}
        </div>
        <button className="btn sm" onClick={onProcess} title={t('process.title')}>
          <Brain size={15} /> {t('chat.process')}
        </button>
        <button className="btn sm" onClick={() => void api.invoke(IPC.threadNew)}>
          <MessageSquarePlus size={15} /> {t('threads.new')}
        </button>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div className="thread-list glass" initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.2 }}>
            {ts.threads.length === 0 && <div className="thread-empty">{t('threads.empty')}</div>}
            {ts.threads.map((th) => (
              <div
                key={th.id}
                className={'thread-item' + (th.id === ts.currentId ? ' active' : '')}
                onClick={() => {
                  if (editing === th.id) return
                  void api.invoke(IPC.threadSwitch, th.id)
                  setOpen(false)
                }}
              >
                {editing === th.id ? (
                  <input
                    className="input"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      void api.invoke(IPC.threadRename, th.id, draft.trim() || th.title)
                      setEditing('')
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div className="tt">
                      <b>{th.title || t('threads.newTitle')}</b>
                      <small>{relTime(th.updatedAt, locale)}</small>
                    </div>
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDraft(th.title)
                        setEditing(th.id)
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.invoke(IPC.threadDelete, th.id)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function ProcessDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useT()
  const chat = useApp((s) => s.chat)
  // everything since the last user message = the current / latest turn
  let start = 0
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].kind === 'user') { start = i; break }
  const turn = chat.slice(start)
  const user = turn.find((c) => c.kind === 'user')
  const thinking = turn.filter((c): c is Extract<ChatItem, { kind: 'thinking' }> => c.kind === 'thinking')
  const steps = turn.filter((c): c is Extract<ChatItem, { kind: 'tool' }> => c.kind === 'tool')
  const [openStep, setOpenStep] = useState('')
  return (
    <motion.div className="process-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
      <motion.aside className="process glass" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>{t('process.title')}</h3>
            {user && user.kind === 'user' && <p>“{user.text.slice(0, 120)}”</p>}
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="process-body">
          {thinking.length === 0 && steps.length === 0 && <div className="thread-empty">{t('process.empty')}</div>}
          {thinking.length > 0 && (
            <section>
              <h4>
                <Brain size={14} /> {t('process.thinking')}
              </h4>
              {thinking.map((th) => (
                <div key={th.id} className="think-body full">
                  {th.text}
                </div>
              ))}
            </section>
          )}
          {steps.length > 0 && (
            <section>
              <h4>
                <Wrench size={14} /> {t('process.steps')} · {steps.length}
              </h4>
              <ol className="timeline">
                {steps.map((st) => {
                  const tool = st.tool
                  const running = tool.status === 'running' || tool.status === 'pending'
                  return (
                    <li key={st.id} className={tool.status} onClick={() => setOpenStep(openStep === st.id ? '' : st.id)}>
                      <div className="row1">
                        <b>{tool.tool.replace(/^jarvis_/, '')}</b>
                        <span>{toolSummary(tool)}</span>
                        <em>{running ? '…' : tool.ms ? (tool.ms / 1000).toFixed(1) + 's' : ''}</em>
                      </div>
                      {openStep === st.id && (
                        <div className="tool-detail">
                          {tool.input != null && Object.keys(tool.input as object).length > 0 ? <pre>{JSON.stringify(tool.input, null, 2)}</pre> : null}
                          {tool.output && <pre>{tool.output}</pre>}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
        </div>
      </motion.aside>
    </motion.div>
  )
}

/** "What Jarvis is doing right now": rolling step list with live spinner and elapsed time. */
function LiveSteps({ status }: { status: AppStatus }) {
  const [, tick] = useState(0)
  const started = status.turnStartedAt
  useEffect(() => {
    if (!started) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [started])
  const steps = status.steps
  if (!steps?.length || !started) return null
  const secs = Math.max(0, Math.round((Date.now() - started) / 1000))
  return (
    <div className="live-steps">
      <div className="live-head">
        <span>{secs}s</span>
      </div>
      <AnimatePresence initial={false}>
        {steps.map((s) => (
          <motion.div key={s.id} className={'live-step ' + s.status} initial={{ opacity: 0, x: -8 }} animate={{ opacity: s.status === 'done' ? 0.55 : 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            {s.status === 'run' ? <Loader2 size={13} className="spin" /> : s.status === 'done' ? <Check size={13} /> : <X size={13} />}
            <span>{s.label}</span>
            {s.ms ? <em>{(s.ms / 1000).toFixed(1)}s</em> : null}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function AssistantPage() {
  const { t, locale } = useT()
  const chat = useApp((s) => s.chat)
  const perms = useApp((s) => s.permissions)
  const status = useApp((s) => s.status)
  const settings = useApp((s) => s.settings)
  const partial = useApp((s) => s.partial)
  const subtitle = useApp((s) => s.subtitle)
  const send = useApp((s) => s.send)
  const reset = useApp((s) => s.resetChat)
  const [text, setText] = useState('')
  const [processOpen, setProcessOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // narrow windows: stack the orb above the chat instead of squeezing the chat into a sliver
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 860))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = feedRef.current
    if (el && stick.current) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  }, [chat, perms.length])

  const submit = () => {
    if (!text.trim()) return
    void send(text)
    setText('')
    stick.current = true
  }

  const busy = status.state === 'thinking' || status.state === 'speaking'
  const hotkey = settings.hotkey.replace('Control', 'Ctrl')
  const tries = locale === 'ru' ? ['Джарвис, открой калькулятор', 'Что у меня на экране? Покажи где кнопка настроек', 'Создай команду «Привет»: открой Spotify и скажи доброе утро', 'Запомни, что я работаю над проектом Atlas'] : ['Jarvis, open the calculator', "What's on my screen? Show me the settings button", 'Create a command “Hello”: open Spotify and say good morning', 'Remember that I am working on project Atlas']

  const live = partial && (status.state === 'listening' || status.state === 'wake' || status.state === 'idle') ? partial : subtitle || (status.state === 'thinking' && status.activity ? '⚙ ' + status.activity : '')

  return (
    <div className="page">
      <div className={'assistant-page' + (narrow ? ' narrow' : '')} ref={pageRef}>
        <div className="glass stage">
          <Orb state={status.state} size={narrow ? 104 : 340} accent={settings.accent} />
          <div className="state">{t('state.' + status.state)}</div>
          <div className="live">
            <AnimatePresence mode="wait">
              <motion.span key={live} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                {live || ''}
              </motion.span>
            </AnimatePresence>
          </div>
          <LiveSteps status={status} />
          <div className="hint">{status.listeningForWake && !status.steps?.length ? t('home.hint', { hotkey }) : ''}</div>
          <div className="chips">
            <span className={'chip ' + (status.opencode === 'ready' || status.opencode === 'sleeping' ? 'ok' : status.opencode === 'error' ? 'bad' : 'warn')}>
              <i className="dot" />
              agent · {settings.model.split('/')[1]}
            </span>
            <span className={'chip ' + (status.listeningForWake ? 'ok' : status.speech === 'missing-models' ? 'bad' : 'warn')}>
              <i className="dot" />
              {status.listeningForWake ? `“${settings.wakePhrases[0] ?? 'jarvis'}”` : status.speech === 'missing-models' ? 'models missing' : 'wake off'}
            </span>
            {status.controlling && (
              <span className="chip warn">
                <i className="dot" />
                {locale === 'ru' ? 'управляю ПК' : 'controlling PC'}
              </span>
            )}
            <span className={'chip ' + (status.tts === 'ready' ? 'ok' : 'warn')}>
              <i className="dot" />
              voice
            </span>
          </div>
        </div>

        <div className="glass chat">
          <ThreadBar onProcess={() => setProcessOpen(true)} />
          <div
            className="feed"
            ref={feedRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            {chat.length === 0 ? (
              <div className="empty">
                <h2>{t('home.empty.title')}</h2>
                <div>{t('home.empty.sub')}</div>
                <div className="try">
                  <small style={{ letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 11 }}>{t('home.try')}</small>
                  {tries.map((q) => (
                    <button key={q} onClick={() => void send(q.replace(/^(Jarvis|Джарвис), /, ''))}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chat.map((c) => <Message key={c.id} item={c} />)
            )}
            {/* same approval cards as the always-on-top HUD, so they are never missed */}
            <PermissionStack inline />
          </div>
          <div className="composer">
            <div className="field">
              <input
                value={text}
                placeholder={t('home.placeholder')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              <button className={'icon-btn mic' + (status.state === 'listening' ? ' on' : '')} title={t('ui.listen')} onClick={() => api.invoke(IPC.toggleListen)}>
                <Mic size={18} />
              </button>
            </div>
            {busy ? (
              <button className="icon-btn primary" title={t('chat.stop')} onClick={() => api.invoke(IPC.abort)}>
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button className="icon-btn primary" title={t('ui.send')} onClick={submit}>
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
      <AnimatePresence>{processOpen && <ProcessDrawer onClose={() => setProcessOpen(false)} />}</AnimatePresence>
    </div>
  )
}
