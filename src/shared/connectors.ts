import type { ConnectorConfig } from './types'

/** A value the user has to supply when adding a preset. */
export interface PresetField {
  key: string
  label: [string, string] // [ru, en]
  /** where the value goes */
  to: 'header' | 'env' | 'oauthClientId' | 'oauthClientSecret' | 'scope' | 'arg'
  /** header / env-variable name (to = header | env) */
  name?: string
  /** header value template, {v} = the entered value */
  template?: string
  secret?: boolean
  optional?: boolean
  placeholder?: string
  value?: string
}

export type PresetCategory = 'google' | 'productivity' | 'dev' | 'search' | 'files' | 'browser'

export interface ConnectorPreset {
  id: string
  name: string
  category: PresetCategory
  desc: [string, string]
  type: 'remote' | 'local'
  url?: string
  command?: string
  noOAuth?: boolean
  fields?: PresetField[]
  /** page where the credentials are created */
  keyUrl?: string
  /** local servers need a runtime on the PC */
  needs?: 'node' | 'uv'
  /** extra hint shown in the form */
  note?: [string, string]
}

const GOOGLE_NOTE: [string, string] = [
  'Нужен ваш Google Cloud проект: включите API и его MCP-сервис, создайте OAuth-клиент (Web application, отметка «AI-агент») и добавьте redirect URI http://127.0.0.1:19876/mcp/oauth/callback. Серверы Google пока в Developer Preview.',
  'Needs your own Google Cloud project: enable the API and its MCP service, create an OAuth client (Web application, "AI-powered agent" option) and add the redirect URI http://127.0.0.1:19876/mcp/oauth/callback. Google servers are in Developer Preview.'
]
const googleFields = (scope: string): PresetField[] => [
  { key: 'cid', label: ['OAuth Client ID', 'OAuth Client ID'], to: 'oauthClientId', placeholder: '123…apps.googleusercontent.com' },
  { key: 'sec', label: ['OAuth Client Secret', 'OAuth Client Secret'], to: 'oauthClientSecret', secret: true },
  { key: 'scope', label: ['Scopes', 'Scopes'], to: 'scope', value: scope }
]
const G = 'https://www.googleapis.com/auth/'
const GOOGLE_KEYS = 'https://console.cloud.google.com/auth/clients'

export const CATEGORY_LABEL: Record<PresetCategory, [string, string]> = {
  google: ['Google', 'Google'],
  productivity: ['Работа и заметки', 'Work & notes'],
  dev: ['Разработка', 'Development'],
  search: ['Поиск и знания', 'Search & knowledge'],
  files: ['Файлы', 'Files'],
  browser: ['Браузер', 'Browser']
}

export const PRESETS: ConnectorPreset[] = [
  // ---- Google Workspace (official remote MCP servers, preview) ----
  { id: 'gmail', name: 'Gmail', category: 'google', type: 'remote', url: 'https://gmailmcp.googleapis.com/mcp/v1', desc: ['Читать и искать письма, создавать черновики, метки', 'Search and read mail, draft messages, manage labels'], fields: googleFields(`${G}gmail.readonly ${G}gmail.compose`), keyUrl: GOOGLE_KEYS, note: GOOGLE_NOTE },
  { id: 'calendar', name: 'Google Calendar', category: 'google', type: 'remote', url: 'https://calendarmcp.googleapis.com/mcp/v1', desc: ['События, расписание, свободные слоты для встреч', 'Events, schedule, free meeting slots'], fields: googleFields(`${G}calendar.readonly ${G}calendar.events`), keyUrl: GOOGLE_KEYS, note: GOOGLE_NOTE },
  { id: 'gdrive', name: 'Google Drive', category: 'google', type: 'remote', url: 'https://drivemcp.googleapis.com/mcp/v1', desc: ['Найти, прочитать и создать файлы', 'Find, read and create files'], fields: googleFields(`${G}drive.readonly ${G}drive.file`), keyUrl: GOOGLE_KEYS, note: GOOGLE_NOTE },
  { id: 'gdocs', name: 'Google Docs', category: 'google', type: 'remote', url: 'https://docsmcp.googleapis.com/mcp/v1', desc: ['Читать и править документы', 'Read and edit documents'], fields: googleFields(`${G}documents`), keyUrl: GOOGLE_KEYS, note: GOOGLE_NOTE },
  { id: 'gsheets', name: 'Google Sheets', category: 'google', type: 'remote', url: 'https://sheetsmcp.googleapis.com/mcp/v1', desc: ['Читать и править таблицы', 'Read and edit spreadsheets'], fields: googleFields(`${G}spreadsheets`), keyUrl: GOOGLE_KEYS, note: GOOGLE_NOTE },
  {
    id: 'workspace-community',
    name: 'Google Workspace (community)',
    category: 'google',
    type: 'local',
    command: 'uvx workspace-mcp --tool-tier core',
    needs: 'uv',
    desc: ['Gmail + Календарь + Drive + Docs одним локальным сервером (без Developer Preview)', 'Gmail + Calendar + Drive + Docs in one local server (no Developer Preview needed)'],
    fields: [
      { key: 'cid', label: ['Google OAuth Client ID', 'Google OAuth Client ID'], to: 'env', name: 'GOOGLE_OAUTH_CLIENT_ID' },
      { key: 'sec', label: ['Google OAuth Client Secret', 'Google OAuth Client Secret'], to: 'env', name: 'GOOGLE_OAUTH_CLIENT_SECRET', secret: true },
      { key: 'mail', label: ['Ваш Google e-mail', 'Your Google e-mail'], to: 'env', name: 'USER_GOOGLE_EMAIL', optional: true, placeholder: 'you@gmail.com' }
    ],
    keyUrl: GOOGLE_KEYS,
    note: [
      'Создайте OAuth-клиент типа Desktop app и включите Gmail / Calendar / Drive API. Вход в Google откроется в браузере при первом обращении агента. Нужен uv (docs.astral.sh/uv).',
      'Create an OAuth client of type Desktop app and enable the Gmail / Calendar / Drive APIs. The Google sign-in opens in your browser on first use. Requires uv (docs.astral.sh/uv).'
    ]
  },

  // ---- productivity ----
  { id: 'notion', name: 'Notion', category: 'productivity', type: 'remote', url: 'https://mcp.notion.com/mcp', desc: ['Страницы, базы и заметки Notion (вход через браузер)', 'Notion pages, databases and notes (browser sign-in)'] },
  { id: 'linear', name: 'Linear', category: 'productivity', type: 'remote', url: 'https://mcp.linear.app/mcp', desc: ['Задачи, проекты и комментарии (вход через браузер)', 'Issues, projects and comments (browser sign-in)'] },
  { id: 'sentry', name: 'Sentry', category: 'productivity', type: 'remote', url: 'https://mcp.sentry.dev/mcp', desc: ['Ошибки и проблемы в продакшене', 'Production errors and issues'] },

  // ---- development ----
  {
    id: 'github',
    name: 'GitHub',
    category: 'dev',
    type: 'remote',
    url: 'https://api.githubcopilot.com/mcp/',
    noOAuth: true,
    desc: ['Репозитории, issues, PR, код (по персональному токену)', 'Repos, issues, pull requests, code (personal access token)'],
    fields: [{ key: 'tok', label: ['Personal access token', 'Personal access token'], to: 'header', name: 'Authorization', template: 'Bearer {v}', secret: true, placeholder: 'github_pat_…' }],
    keyUrl: 'https://github.com/settings/personal-access-tokens/new'
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'dev',
    type: 'remote',
    url: 'https://mcp.context7.com/mcp',
    noOAuth: true,
    desc: ['Свежая документация библиотек для кода', 'Up-to-date library docs for coding'],
    fields: [{ key: 'k', label: ['API-ключ (необязательно, повышает лимиты)', 'API key (optional, higher limits)'], to: 'header', name: 'CONTEXT7_API_KEY', secret: true, optional: true }],
    keyUrl: 'https://context7.com/dashboard'
  },
  { id: 'deepwiki', name: 'DeepWiki', category: 'dev', type: 'remote', url: 'https://mcp.deepwiki.com/mcp', noOAuth: true, desc: ['Вопросы по любому публичному GitHub-репозиторию, без ключа', 'Ask about any public GitHub repo, no key'] },
  { id: 'gh_grep', name: 'Grep by Vercel', category: 'dev', type: 'remote', url: 'https://mcp.grep.app', noOAuth: true, desc: ['Поиск примеров кода по миллионам репозиториев', 'Search code examples across millions of repos'] },

  // ---- search ----
  { id: 'parallel', name: 'Parallel Search', category: 'search', type: 'remote', url: 'https://search.parallel.ai/mcp', noOAuth: true, desc: ['Веб-поиск для агента, без ключа и аккаунта', 'Web search for the agent, no key or account'] },
  {
    id: 'brave',
    name: 'Brave Search',
    category: 'search',
    type: 'local',
    command: 'npx -y @modelcontextprotocol/server-brave-search',
    needs: 'node',
    desc: ['Веб- и локальный поиск Brave', 'Brave web and local search'],
    fields: [{ key: 'k', label: ['Brave API key', 'Brave API key'], to: 'env', name: 'BRAVE_API_KEY', secret: true }],
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys'
  },
  { id: 'fetch', name: 'Fetch', category: 'search', type: 'local', command: 'uvx mcp-server-fetch', needs: 'uv', desc: ['Загрузка страниц и преобразование в текст', 'Fetch pages and convert them to text'] },

  // ---- files ----
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'files',
    type: 'local',
    command: 'npx -y @modelcontextprotocol/server-filesystem',
    needs: 'node',
    desc: ['Доступ к выбранной папке', 'Access to a chosen folder'],
    fields: [{ key: 'dir', label: ['Папка', 'Folder'], to: 'arg', placeholder: 'C:\\Users\\you\\Documents' }]
  },

  // ---- browser ----
  { id: 'playwright', name: 'Playwright', category: 'browser', type: 'local', command: 'npx -y @playwright/mcp@latest', needs: 'node', desc: ['Автоматизация браузера: страницы, формы, скриншоты', 'Browser automation: pages, forms, screenshots'] }
]

/** "foo bar" 'x y' → ['foo','bar','x y'] */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export const connectorId = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'connector'

/** Build a connector from a preset and the values the user typed. */
export function fromPreset(p: ConnectorPreset, values: Record<string, string>): ConnectorConfig {
  const c: ConnectorConfig = { id: connectorId(p.id), name: p.name, preset: p.id, type: p.type, url: p.url, command: p.command, headers: {}, env: {}, noOAuth: p.noOAuth, enabled: true }
  const oauth: NonNullable<ConnectorConfig['oauth']> = {}
  const args: string[] = []
  for (const f of p.fields ?? []) {
    const v = (values[f.key] ?? f.value ?? '').trim()
    if (!v) continue
    if (f.to === 'header') c.headers[f.name!] = (f.template ?? '{v}').replace('{v}', v)
    else if (f.to === 'env') c.env[f.name!] = v
    else if (f.to === 'oauthClientId') oauth.clientId = v
    else if (f.to === 'oauthClientSecret') oauth.clientSecret = v
    else if (f.to === 'scope') oauth.scope = v
    else if (f.to === 'arg') args.push(/\s/.test(v) ? `"${v}"` : v)
  }
  if (Object.keys(oauth).length) c.oauth = oauth
  if (args.length && c.command) c.command += ' ' + args.join(' ')
  return c
}
