// Smoke test for resources/native/jarvis-native.exe: npx tsx scripts/test-native.mts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const exe = join(process.cwd(), 'resources', 'native', 'jarvis-native.exe')
const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map<number, (v: any) => void>()
let seq = 0
let ready!: () => void
const isReady = new Promise<void>((r) => (ready = r))
createInterface({ input: p.stdout }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.id === 0) return ready()
  pending.get(m.id)?.(m)
})
const call = (cmd: string, args: Record<string, unknown> = {}) =>
  new Promise<any>((res) => {
    const id = ++seq
    pending.set(id, res)
    p.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
  })
const t = async (label: string, cmd: string, args: Record<string, unknown> = {}) => {
  const t0 = Date.now()
  const r = await call(cmd, args)
  console.log(`${label.padEnd(26)} ${String(Date.now() - t0).padStart(5)}ms  ${r.ok ? 'ok ' : 'ERR'} ${JSON.stringify(r.ok ? r.result : r.error).slice(0, 220)}`)
  return r.result
}

const t0 = Date.now()
await isReady
console.log('startup', Date.now() - t0, 'ms')
await t('ping', 'ping')
await t('ocr_langs', 'ocr_langs')
const wins = await t('list_windows', 'list_windows')
const apps = await t('list_apps', 'list_apps')
console.log('  running apps', apps.running.length, 'installed', apps.installed.length)
try { execSync('taskkill /F /IM CalculatorApp.exe', { stdio: 'ignore' }) } catch {}
const l = await t('launch calculator', 'launch', { name: 'Калькулятор', wait: 8000 })
const calc = l?.window?.hwnd
if (calc) {
  const st = await t('get_window_state', 'get_window_state', { window: calc, max_dim: 1200 })
  const tree: string = st.accessibility.tree
  console.log(tree.split('\n').slice(0, 14).join('\n'))
  const idx = (label: string) => {
    const line = tree.split('\n').find((x) => x.replace(/^\s*\d+ /, '').startsWith('button ' + label + ' '))
    return line ? parseInt(line.trim()) : -1
  }
  // clear, then 1 2 × 7 =
  const keys = ['Один', 'Два', 'Умножить на', 'Семь', 'Равно'].map(idx)
  console.log('  indexes', keys)
  console.log(tree.split('\n').filter((x) => /^\s*(29|3\d|4[0-5]) /.test(x)).map((x) => x.trim().replace(/Secondary Actions: [^F]*/, '')).join('\n'))
  for (const k of keys) {
    if (k < 0) continue
    await t(`click element ${k}`, 'click', { window: calc, element_index: k, settle: 400 })
    const s = await call('get_window_state', { window: calc, include_screenshot: false })
    console.log('    after', k, (s.result.accessibility.tree.match(/Отображать как[^\n]*?(?= \(| Secondary)/) || s.result.accessibility.tree.match(/Выражение[^\n]*?(?= Secondary)/) || [''])[0])
  }
  const st2 = await t('state after', 'get_window_state', { window: calc, include_screenshot: false })
  console.log('  display:', (st2.accessibility.tree.match(/Отображать как.*$/m) || [''])[0])
  await t('press_key Escape', 'press_key', { window: calc, key: 'Escape' })
  await t('type_text 5*5=', 'type_text', { window: calc, text: '5*5=' })
  const st3 = await t('state after typing', 'get_window_state', { window: calc, include_screenshot: false })
  console.log('  display:', (st3.accessibility.tree.match(/Отображать как.*$/m) || [''])[0])
  await t('ocr_window', 'ocr_window', { window: calc })
  await t('press_key alt+F4', 'press_key', { window: calc, key: 'Alt_L+F4', settle: 0 })
}
await new Promise((r) => setTimeout(r, 11000))
const mem = execSync(`powershell -NoProfile -Command "$p=Get-Process -Id ${p.pid}; [int]($p.WorkingSet64/1MB), [int]($p.PrivateMemorySize64/1MB)"`).toString().trim().replace(/s+/g, " / ")
console.log('working set MB', mem)
p.kill()
