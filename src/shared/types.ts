export type Lang = 'ru' | 'en'
export type AssistantState = 'idle' | 'wake' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export interface Settings {
  apiKey: string
  model: string // "providerID/modelID"
  wakePhrases: string[] // extra wake aliases, lowercase
  wakeEnabled: boolean
  wakeSensitivity: number // 0..1, fuzzy threshold strictness
  interfaceLang: Lang | 'auto'
  micDeviceId: string
  sttModel: 'parakeet-en' | 'whisper-base' | 'whisper-small' | 'whisper-turbo'
  sttLanguage: 'auto' | Lang
  voiceEnabled: boolean
  voiceRu: string
  voiceEn: string
  voiceSpeed: number
  voiceVolume: number
  voiceFx: boolean
  hotkey: string
  accent: string
  theme: 'dark' | 'light' | 'system'
  autoStart: boolean
  startMinimized: boolean
  permissionMode: 'ask' | 'safe-auto' | 'full-auto'
  showSubtitles: boolean
  hudCorner: 'br' | 'bl' | 'tr' | 'tl'
  cwd: string
  followupSeconds: number
  autoNewThreadMinutes: number
  visionModel: string
  cloneOffered: boolean
  fishApiKey: string
  fishModel: string
  fishVoiceRu: string
  fishVoiceEn: string
  customProvider: { enabled: boolean; name: string; baseURL: string; apiKey: string; models: string }
  /** MCP connectors (Gmail, Calendar, GitHub, Notion, …): extra tools for the agent */
  connectors: ConnectorConfig[]
  fishOffered: boolean
  cloneIdleMinutes: number
  sttV2: boolean
  wakeAck: 'always' | 'wake-only' | 'off'
  customSystemPrompt: string
  wakeSound: boolean
  setupDone: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'opencode/deepseek-v4.1-flash-free',
  wakePhrases: ['джарвис', 'jarvis'],
  wakeEnabled: true,
  wakeSensitivity: 0.6,
  interfaceLang: 'auto',
  micDeviceId: 'default',
  sttModel: 'parakeet-en',
  sttLanguage: 'auto',
  voiceEnabled: true,
  voiceRu: 'ru_RU-denis-medium',
  voiceEn: 'jarvis-high',
  voiceSpeed: 1,
  voiceVolume: 0.9,
  voiceFx: true,
  hotkey: 'Control+Alt+J',
  accent: '#38d6ff',
  theme: 'dark',
  autoStart: false,
  startMinimized: false,
  permissionMode: 'safe-auto',
  showSubtitles: true,
  hudCorner: 'br',
  cwd: '',
  followupSeconds: 7,
  autoNewThreadMinutes: 45,
  visionModel: 'auto',
  cloneOffered: false,
  fishApiKey: '',
  fishModel: 's2.1-pro-free',
  // public Jarvis voice ids on Fish Audio (not secrets) — shipped as defaults
  fishVoiceRu: '680d74fbef69419f87cfc70f092a1451',
  fishVoiceEn: '14129c3e320149449d6bada6862f7338',
  customProvider: { enabled: false, name: 'Custom', baseURL: '', apiKey: '', models: '' },
  connectors: [],
  fishOffered: false,
  cloneIdleMinutes: 10,
  sttV2: false,
  wakeAck: 'always',
  customSystemPrompt: '',
  wakeSound: true,
  setupDone: false
}

export interface Thread {
  id: string
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface ThreadState {
  threads: Thread[]
  currentId: string
}

export interface ConnectorConfig {
  /** lower-case id, also the prefix of the tool names the agent sees (gmail_search…) */
  id: string
  name: string
  preset?: string
  type: 'remote' | 'local'
  url?: string
  /** local servers: command line (quotes allowed) */
  command?: string
  headers: Record<string, string>
  env: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string }
  /** remote server authenticates with a key in `headers`, never try OAuth */
  noOAuth?: boolean
  enabled: boolean
}

export interface ConnectorStatus {
  status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'unknown'
  error?: string
}

export interface ProviderInfo {
  id: string
  name: string
  env: string[]
  connected: boolean
  models: number
}

export interface ModelInfo {
  id: string // providerID/modelID
  name: string
  free: boolean
  vision: boolean
  provider: string
}

export interface ToolEvent {
  id: string
  tool: string
  title?: string
  status: 'pending' | 'running' | 'completed' | 'error'
  input?: unknown
  output?: string
  startedAt?: number
  ms?: number
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string; at: number; via: 'voice' | 'text' }
  | { id: string; kind: 'assistant'; text: string; at: number; done: boolean }
  | { id: string; kind: 'tool'; tool: ToolEvent; at: number }
  | { id: string; kind: 'say'; text: string; at: number }
  | { id: string; kind: 'thinking'; text: string; at: number; done: boolean; ms?: number }
  | { id: string; kind: 'system'; text: string; at: number }

export interface PermissionRequest {
  id: string
  kind: 'permission' | 'question'
  title: string
  detail?: string
  options?: string[]
  multiple?: boolean
  hint?: string
}

export interface Routine {
  id: string
  name: string
  phrases: string[]
  steps: RoutineStep[]
  createdAt: number
  updatedAt: number
}

export type RoutineStep =
  | { type: 'say'; text: string }
  | { type: 'open'; target: string } // app / url / file
  | { type: 'run'; command: string } // powershell command
  | { type: 'keys'; keys: string } // e.g. "ctrl+shift+t"
  | { type: 'type'; text: string }
  | { type: 'wait'; ms: number }
  | { type: 'agent'; prompt: string } // free-form task handled by the agent

export interface MemoryItem {
  id: string
  text: string
  tags: string[]
  createdAt: number
  pinned: boolean
}

export interface HighlightTarget {
  x: number
  y: number
  w: number
  h: number
  label?: string
  shape?: 'box' | 'circle' | 'arrow' | 'underline'
}

export interface ModelAsset {
  id: string
  name: string
  kind: 'vad' | 'wake' | 'stt' | 'tts'
  sizeMB: number
  required: boolean
  installed: boolean
  note?: string
}

export interface SetupProgress {
  id: string
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  received: number
  total: number
  error?: string
}

export interface AppStatus {
  state: AssistantState
  opencode: 'starting' | 'ready' | 'error' | 'stopped'
  speech: 'loading' | 'ready' | 'error' | 'missing-models'
  tts: 'ready' | 'missing-voice' | 'error'
  listeningForWake: boolean
  message?: string
  activity?: string
  controlling?: boolean
  clone?: 'off' | 'starting' | 'ready' | 'error'
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',
  status: 'status',
  chat: 'chat:item',
  chatReset: 'chat:reset',
  threads: 'threads:list',
  threadNew: 'threads:new',
  threadSwitch: 'threads:switch',
  threadDelete: 'threads:delete',
  threadRename: 'threads:rename',
  threadsChanged: 'threads:changed',
  chatHistory: 'chat:history',
  sendText: 'chat:send',
  abort: 'chat:abort',
  models: 'models:list',
  modelAssets: 'assets:list',
  modelDownload: 'assets:download',
  modelProgress: 'assets:progress',
  permission: 'permission:request',
  permissionReply: 'permission:reply',
  permissionClose: 'permission:close',
  audioChunk: 'audio:chunk',
  micLevel: 'audio:level',
  transcript: 'stt:transcript',
  ttsPlay: 'tts:play',
  ttsStop: 'tts:stop',
  ttsEnded: 'tts:ended',
  ttsLevel: 'tts:level',
  routines: 'routines:list',
  routinesSave: 'routines:save',
  routinesDelete: 'routines:delete',
  routinesRun: 'routines:run',
  routinesChanged: 'routines:changed',
  memory: 'memory:list',
  memoryAdd: 'memory:add',
  memoryDelete: 'memory:delete',
  memoryPin: 'memory:pin',
  memoryChanged: 'memory:changed',
  highlight: 'overlay:highlight',
  highlightClear: 'overlay:clear',
  toggleListen: 'listen:toggle',
  window: 'window:action',
  openPath: 'shell:openPath',
  captureForUi: 'ui:capture',
  subtitle: 'hud:subtitle'
} as const
