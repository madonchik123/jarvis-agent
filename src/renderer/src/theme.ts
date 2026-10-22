export function applyTheme(accent: string, theme: 'dark' | 'light' | 'system') {
  const root = document.documentElement
  root.style.setProperty('--accent', accent)
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme
  root.setAttribute('data-theme', resolved)
}
