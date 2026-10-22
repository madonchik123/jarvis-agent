import { create } from 'zustand'
import { api, IPC, levels } from './api'
import { DEFAULT_SETTINGS, type ThreadState, type AppStatus, type ChatItem, type MemoryItem, type ModelAsset, type ModelInfo, type PermissionRequest, type Routine, type Settings, type SetupProgress } from '@shared/types'
import { resolveLocale, translate, type Locale } from './i18n'

export type Page = 'assistant' | 'routines' | 'memory' | 'settings'

interface AppState {
  ready: boolean
  settings: Settings
  status: AppStatus
  page: Page
  chat: ChatItem[]
  permissions: PermissionRequest[]
  subtitle: string
  partial: string
  routines: Routine[]
  memory: MemoryItem[]
  threads: ThreadState
  loadChat: () => Promise<void>
  models: ModelInfo[]
  assets: ModelAsset[]
  progress: Record<string, SetupProgress>
  setupOpen: boolean
  setPage: (p: Page) => void
  patchSettings: (p: Partial<Settings>) => Promise<void>
  send: (text: string) => Promise<void>
  loadRoutines: () => Promise<void>
  loadMemory: () => Promise<void>
  loadAssets: () => Promise<void>
  fetchModels: (all: boolean) => Promise<void>
  downloadAssets: (ids: string[]) => Promise<void>
  closeSetup: () => void
  resetChat: () => Promise<void>
}

const baseStatus: AppStatus = { state: 'idle', opencode: 'starting', speech: 'loading', tts: 'ready', listeningForWake: false }

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  status: baseStatus,
  page: 'assistant',
  chat: [],
  permissions: [],
  subtitle: '',
  partial: '',
  routines: [],
  memory: [],
  threads: { threads: [], currentId: '' },
  loadChat: async () => set({ chat: ((await api.invoke(IPC.chatHistory)) as ChatItem[]) ?? [], threads: (await api.invoke(IPC.threads)) ?? { threads: [], currentId: '' } }),
  models: [],
  assets: [],
  progress: {},
  setupOpen: false,
  setPage: (page) => set({ page }),
  patchSettings: async (p) => {
    set((s) => ({ settings: { ...s.settings, ...p } }))
    await api.invoke(IPC.settingsSet, p)
  },
  send: async (text) => {
    if (!text.trim()) return
    await api.invoke(IPC.sendText, text.trim())
  },
  loadRoutines: async () => set({ routines: (await api.invoke(IPC.routines)) ?? [] }),
  loadMemory: async () => set({ memory: (await api.invoke(IPC.memory)) ?? [] }),
  loadAssets: async () => set({ assets: (await api.invoke(IPC.modelAssets)) ?? [] }),
  fetchModels: async (all) => set({ models: (await api.invoke(IPC.models, all)) ?? [] }),
  downloadAssets: async (ids) => {
    const res = await api.invoke(IPC.modelDownload, ids)
    if (res) set({ assets: res })
  },
  closeSetup: () => {
    set({ setupOpen: false })
    void get().patchSettings({ setupDone: true })
  },
  resetChat: async () => {
    await api.invoke(IPC.threadNew)
  }
}))

export function upsertChat(list: ChatItem[], item: ChatItem): ChatItem[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) {
    const copy = list.slice()
    copy[i] = item
    return copy
  }
  return [...list, item].slice(-200)
}

/** Subscribes the store to main-process events. Call once per window. */
export async function bootstrap(opts: { chat?: boolean } = {}) {
  const st = useApp
  const settings: Settings = (await api.invoke(IPC.settingsGet)) ?? DEFAULT_SETTINGS
  const status: AppStatus = (await api.invoke('status:get')) ?? baseStatus
  st.setState({ settings, status, ready: true })
  api.on(IPC.settingsChanged, (s: Settings) => st.setState({ settings: s }))
  api.on(IPC.status, (s: AppStatus) => st.setState({ status: s }))
  api.on(IPC.subtitle, (t: string) => st.setState({ subtitle: t }))
  api.on(IPC.transcript, (t: string) => st.setState({ partial: t }))
  api.on(IPC.micLevel, (v: number) => (levels.mic = v))
  api.on(IPC.ttsLevel, (v: number) => (levels.tts = v))
  api.on(IPC.permission, (r: PermissionRequest) => st.setState((s) => ({ permissions: [...s.permissions.filter((p) => p.id !== r.id), r] })))
  api.on(IPC.permissionClose, (id: string) => st.setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== id) })))
  api.on(IPC.modelProgress, (p: SetupProgress) => st.setState((s) => ({ progress: { ...s.progress, [p.id]: p } })))
  if (opts.chat) {
    api.on(IPC.chat, (item: ChatItem) => st.setState((s) => ({ chat: upsertChat(s.chat, item), partial: item.kind === 'user' ? '' : s.partial })))
    api.on(IPC.chatReset, () => void st.getState().loadChat())
    api.on(IPC.threadsChanged, (t: ThreadState) => st.setState({ threads: t }))
    await st.getState().loadChat()
    await Promise.all([st.getState().loadRoutines(), st.getState().loadMemory(), st.getState().loadAssets(), st.getState().fetchModels(false)])
    api.on(IPC.routinesChanged, () => void st.getState().loadRoutines())
    api.on(IPC.memoryChanged, () => void st.getState().loadMemory())
    const missing = st.getState().assets.some((a) => a.required && !a.installed)
    if (!settings.setupDone || missing) st.setState({ setupOpen: true })
  }
}

export function useT() {
  const pref = useApp((s) => s.settings.interfaceLang)
  const locale: Locale = resolveLocale(pref)
  return { locale, t: (key: string, vars?: Record<string, string>) => translate(locale, key, vars) }
}
