import { spawn } from 'child_process'
import { createInterface } from 'readline'

const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'resources/bridge.ps1'], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: p.stdout })
const pending = new Map<number, (m: any) => void>()
let seq = 0
rl.on('line', (l) => {
  try {
    const m = JSON.parse(l)
    pending.get(m.id)?.(m)
  } catch {
    console.log('raw:', l)
  }
})
const call = (cmd: string, args: any = {}) =>
  new Promise<any>((res) => {
    const id = ++seq
    pending.set(id, res)
    p.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
  })
await new Promise((r) => setTimeout(r, 2500))
const arg = process.argv[2] || 'calc'

if (arg === 'calc') {
  const l = await call('launch', { name: 'Calculator', wait: 6000 }, 20000)
  console.log('launch', JSON.stringify(l).slice(0, 300))
  await new Promise((r) => setTimeout(r, 800))
  const fg = await call('foreground')
  console.log('fg', JSON.stringify(fg.result))
  const t = Date.now()
  const u = await call('uia', { hwnd: fg.result.hwnd || l.result.window?.hwnd, max: 80 })
  console.log('uia ms', Date.now() - t, u.ok ? `n=${u.result.elements.length} cls=${u.result.cls} errors=${u.result.errors} first=${u.result.firstError}` : u.error)
  for (const e of (u.result?.elements ?? []).slice(0, 25)) console.log(' ', e.id, e.type, JSON.stringify(e.name), e.x, e.y, e.w, e.h)
  await call('keys', { keys: 'alt+f4' })
} else {
  const w = await call('windows')
  const target = (w.result as any[]).find((x) => x.process.toLowerCase().includes(arg.toLowerCase()))
  console.log('target', JSON.stringify(target))
  for (let i = 0; i < 2; i++) {
    const t = Date.now()
    const u = await call('uia', { hwnd: target.hwnd, max: 120 }, 30000)
    console.log('uia#' + i, 'ms', Date.now() - t, u.ok ? `n=${u.result.elements.length} cls=${u.result.cls}` : u.error)
    for (const e of (u.result?.elements ?? []).slice(0, 18)) console.log(' ', e.id, e.type, JSON.stringify(e.name).slice(0, 60), e.x, e.y, e.w, e.h)
  }
}
p.kill()
process.exit(0)
