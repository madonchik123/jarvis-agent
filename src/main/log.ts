import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

/** Tees console output into %APPDATA%\Jarvis\logs\jarvis.log (rotated at 2 MB) so problems can be diagnosed after the fact. */
let file = ''

export function logDir() {
  return join(app.getPath('userData'), 'logs')
}

export function initLogging() {
  const dir = logDir()
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'jarvis.log')
  try {
    if (existsSync(file) && statSync(file).size > 2_000_000) renameSync(file, join(dir, 'jarvis.old.log'))
  } catch {}
  const write = (level: string, args: unknown[]) => {
    try {
      const msg = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(' ')
      appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}\n`)
    } catch {}
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      write(level.toUpperCase(), args)
    }
  }
  process.on('uncaughtException', (e) => write('FATAL', ['uncaughtException', e]))
  process.on('unhandledRejection', (e) => write('ERROR', ['unhandledRejection', e]))
  console.log(`--- Jarvis ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform} ${process.arch})`)
}
