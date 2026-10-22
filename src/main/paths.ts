import { app } from 'electron'
import { join } from 'path'
import { is } from './is'

export function preloadPath() {
  return join(__dirname, '../preload/index.js')
}

/** URL of a renderer entry page (dev server in development, packaged file otherwise). */
export function rendererUrl(page: string, query = '') {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) return `${process.env['ELECTRON_RENDERER_URL']}/${page}${query}`
  return `file://${join(__dirname, '../renderer', page).replace(/\\/g, '/')}${query}`
}

export function resourcePath(...p: string[]) {
  return app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), 'resources', ...p)
}
