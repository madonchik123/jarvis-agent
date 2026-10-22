import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { EventEmitter } from 'events'
import { DEFAULT_SETTINGS, type MemoryItem, type Routine, type Settings, type Thread, type ThreadState } from '../shared/types'

export const dataDir = () => app.getPath('userData')

function readJson<T>(file: string, fallback: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (e) {
    console.error('[store] failed to read', file, e)
  }
  return fallback
}

function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

class JsonStore<T> extends EventEmitter {
  protected data: T
  constructor(
    protected file: string,
    fallback: T
  ) {
    super()
    this.data = readJson(file, fallback)
  }
  protected save() {
    writeJson(this.file, this.data)
    this.emit('change', this.data)
  }
}

export class SettingsStore extends JsonStore<Settings> {
  constructor() {
    super(join(dataDir(), 'settings.json'), { ...DEFAULT_SETTINGS })
    this.data = { ...DEFAULT_SETTINGS, ...this.data }
  }
  get(): Settings {
    return this.data
  }
  set(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch }
    this.save()
    return this.data
  }
}

export class MemoryStore extends JsonStore<MemoryItem[]> {
  constructor() {
    super(join(dataDir(), 'memory.json'), [])
  }
  list() {
    return [...this.data].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  }
  add(text: string, tags: string[] = [], pinned = false): MemoryItem {
    const norm = text.trim()
    const dup = this.data.find((m) => m.text.toLowerCase() === norm.toLowerCase())
    if (dup) return dup
    const item: MemoryItem = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: norm, tags, createdAt: Date.now(), pinned }
    this.data.push(item)
    this.save()
    return item
  }
  delete(id: string) {
    this.data = this.data.filter((m) => m.id !== id)
    this.save()
  }
  pin(id: string, pinned: boolean) {
    const m = this.data.find((x) => x.id === id)
    if (m) {
      m.pinned = pinned
      this.save()
    }
  }
  search(query: string, limit = 8): MemoryItem[] {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
    if (!words.length) return this.list().slice(0, limit)
    const stem = (w: string) => w.slice(0, Math.max(3, w.length - 2))
    return this.data
      .map((m) => {
        const hay = (m.text + ' ' + m.tags.join(' ')).toLowerCase()
        const score = words.reduce((s, w) => s + (hay.includes(stem(w)) ? 1 : 0), 0) + (m.pinned ? 0.5 : 0)
        return { m, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m)
  }
  /** Compact block injected into the agent's system prompt on every turn. */
  promptBlock(max = 25): string {
    const items = this.list().slice(0, max)
    if (!items.length) return ''
    return items.map((m) => `- [${m.id}] ${m.text}`).join('\n')
  }
}

export class RoutineStore extends JsonStore<Routine[]> {
  constructor() {
    super(join(dataDir(), 'routines.json'), [])
  }
  list() {
    return this.data
  }
  get(idOrName: string) {
    const q = idOrName.toLowerCase()
    return this.data.find((r) => r.id === idOrName || r.name.toLowerCase() === q)
  }
  save1(r: Omit<Routine, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Routine {
    const existing = r.id ? this.data.find((x) => x.id === r.id) : this.get(r.name)
    const now = Date.now()
    if (existing) {
      Object.assign(existing, { name: r.name, phrases: r.phrases, steps: r.steps, updatedAt: now })
      this.save()
      return existing
    }
    const created: Routine = { id: 'r' + now.toString(36), name: r.name, phrases: r.phrases, steps: r.steps, createdAt: now, updatedAt: now }
    this.data.push(created)
    this.save()
    return created
  }
  delete(idOrName: string) {
    const r = this.get(idOrName)
    if (!r) return false
    this.data = this.data.filter((x) => x.id !== r.id)
    this.save()
    return true
  }
}

export class ThreadStore extends JsonStore<ThreadState> {
  constructor() {
    super(join(dataDir(), 'threads.json'), { threads: [], currentId: '' })
  }
  state(): ThreadState {
    return { threads: [...this.data.threads].sort((a, b) => b.updatedAt - a.updatedAt), currentId: this.data.currentId }
  }
  get current(): Thread | undefined {
    return this.data.threads.find((t) => t.id === this.data.currentId)
  }
  get(id: string) {
    return this.data.threads.find((t) => t.id === id)
  }
  add(sessionId: string, title = ''): Thread {
    const now = Date.now()
    const t: Thread = { id: 't' + now.toString(36), sessionId, title, createdAt: now, updatedAt: now }
    this.data.threads.push(t)
    this.data.currentId = t.id
    this.save()
    return t
  }
  select(id: string) {
    if (this.get(id)) {
      this.data.currentId = id
      this.save()
    }
  }
  touch(id: string, title?: string) {
    const t = this.get(id)
    if (!t) return
    t.updatedAt = Date.now()
    if (title && (!t.title || t.title.startsWith('New session'))) t.title = title
    this.save()
  }
  rename(id: string, title: string) {
    const t = this.get(id)
    if (t) {
      t.title = title
      this.save()
    }
  }
  setTitleFromSession(sessionId: string, title: string) {
    const t = this.data.threads.find((x) => x.sessionId === sessionId)
    if (t && title && !title.startsWith('New session') && t.title !== title) {
      t.title = title
      this.save()
    }
  }
  remove(id: string) {
    this.data.threads = this.data.threads.filter((t) => t.id !== id)
    if (this.data.currentId === id) this.data.currentId = this.state().threads[0]?.id ?? ''
    this.save()
  }
}
