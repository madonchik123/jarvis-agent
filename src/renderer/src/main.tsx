import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion } from 'framer-motion'
import './styles.css'
import { bootstrap, useApp, useT } from './store'
import { TitleBar, Rail } from './components/Shell'
import { SetupModal } from './components/Overlays'
import { AssistantPage } from './pages/Assistant'
import { RoutinesPage } from './pages/Routines'
import { MemoryPage } from './pages/Memory'
import { SettingsPage } from './pages/Settings'
import { applyTheme } from './theme'

function App() {
  const ready = useApp((s) => s.ready)
  const page = useApp((s) => s.page)
  const settings = useApp((s) => s.settings)
  const status = useApp((s) => s.status)
  const setupOpen = useApp((s) => s.setupOpen)
  const { t } = useT()

  useEffect(() => {
    void bootstrap({ chat: true })
    ;(window as any).__setPage = (p: any) => useApp.getState().setPage(p)
    ;(window as any).__app = useApp
    ;(window as any).__demoLong = () =>
      useApp.setState((st) => ({
        chat: [
          ...st.chat,
          { id: 'demo0', kind: 'user', via: 'voice', at: Date.now(), text: 'Проверь версию node и расскажи что ты умеешь' },
          { id: 'demoT', kind: 'thinking', done: true, ms: 1800, at: Date.now(), text: 'Пользователь просит версию node и список возможностей. Сначала вызову bash для node -v, затем list_apps, потом коротко озвучу итог и дам подробности текстом.' },
          { id: 'demoB', kind: 'tool', at: Date.now(), tool: { id: 'demoB', tool: 'bash', status: 'completed', ms: 3900, input: { command: 'node -v; npm -v' }, output: 'v24.14.0 / npm 11.9.0' } },
          { id: 'demoA', kind: 'tool', at: Date.now(), tool: { id: 'demoA', tool: 'jarvis_list_apps', status: 'completed', ms: 1100, input: {}, output: 'claude -- running; Discord -- running' } },
          {
            id: 'demo1',
            kind: 'assistant',
            done: true,
            at: Date.now(),
            text: `## 1. Node.js

\`\`\`
node: v24.14.0
npm: 11.9.0
npx: 11.9.0
\`\`\`

Стек свежий, LTS-ветка.

## 2. Что я умею

- Вижу экран через дерево доступности
- Управляю приложениями
- Помню факты о вас
- Выполняю голосовые команды
- Ищу в сети
- Пишу код
- Открываю приложения и сайты
- Читаю и правлю файлы`
          }
        ]
      }))
  }, [])
  useEffect(() => applyTheme(settings.accent, settings.theme), [settings.accent, settings.theme])

  if (!ready) return null
  const pages = { assistant: <AssistantPage />, routines: <RoutinesPage />, memory: <MemoryPage />, settings: <SettingsPage /> }
  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        <Rail />
        <main className="content">
          {status.speech === 'missing-models' && !setupOpen && page === 'assistant' && <ModelsBanner />}
          <AnimatePresence mode="wait">
            <motion.div key={page} style={{ height: status.speech === 'missing-models' && page === 'assistant' ? 'calc(100% - 52px)' : '100%' }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
              {pages[page]}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <AnimatePresence>{setupOpen && <SetupModal />}</AnimatePresence>
    </div>
  )
}

/** First-run speech models: shows the background download as progress (or a retry after a failure) instead of "missing". */
function ModelsBanner() {
  const { t } = useT()
  const assets = useApp((s) => s.assets)
  const progress = useApp((s) => s.progress)
  const download = useApp((s) => s.downloadAssets)
  const needed = assets.filter((a) => a.required && !a.installed)
  const active = needed.filter((a) => progress[a.id] && progress[a.id].phase !== 'error' && progress[a.id].phase !== 'done')
  const failed = needed.filter((a) => progress[a.id]?.phase === 'error')
  if (active.length) {
    const totalMB = needed.reduce((n, a) => n + a.sizeMB, 0) || 1
    const doneMB = needed.reduce((n, a) => {
      const p = progress[a.id]
      return n + (p?.phase === 'done' ? a.sizeMB : p && p.total ? (a.sizeMB * p.received) / p.total : 0)
    }, 0)
    return (
      <div className="banner">
        <span>⬇</span> {t('banner.downloading')} {Math.min(99, Math.round((doneMB / totalMB) * 100))}%
      </div>
    )
  }
  if (failed.length)
    return (
      <div className="banner">
        <span>⚠</span> {t('banner.failed')}{' '}
        <button className="btn" style={{ marginLeft: 10, padding: '4px 12px' }} onClick={() => void download(needed.map((a) => a.id))}>
          {t('setup.retry')}
        </button>
      </div>
    )
  return (
    <div className="banner">
      <span>⚠</span> {t('banner.missing')}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
