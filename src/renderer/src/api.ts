import { IPC } from '@shared/types'

export interface JarvisBridge {
  invoke: (channel: string, ...args: any[]) => Promise<any>
  send: (channel: string, ...args: any[]) => void
  on: (channel: string, cb: (...args: any[]) => void) => () => void
}

declare global {
  interface Window {
    jarvis: JarvisBridge
  }
}

export const api: JarvisBridge = window.jarvis ?? {
  // Browser preview fallback (design mode without Electron)
  invoke: async () => undefined,
  send: () => {},
  on: () => () => {}
}

export { IPC }

/** Shared mutable audio levels (read inside requestAnimationFrame, no React re-renders). */
export const levels = { mic: 0, tts: 0 }
