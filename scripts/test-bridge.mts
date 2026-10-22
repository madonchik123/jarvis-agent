import { spawn } from 'child_process'
import { createInterface } from 'readline'
const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'resources/bridge.ps1'], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: p.stdout })
const pending = new Map<number, (m: any) => void>()
let seq = 0
rl.on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m) } catch { console.log('raw:', l) } })
const call = (cmd: string, args: any = {}) => new Promise<any>((res) => { const id = ++seq; pending.set(id, res); p.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n') })
await new Promise((r) => setTimeout(r, 2500))
const show = (n: string, m: any, max = 600) => console.log(n, m.ok ? JSON.stringify(m.result).slice(0, max) : 'ERR ' + m.error)
show('ping', await call('ping'))
show('screens', await call('screen_info'))
show('windows', await call('windows'), 900)
const shot = process.env.SHOT!
show('shot', await call('screenshot', { path: shot }))
let t = Date.now(); show('ocr', await call('ocr', { path: shot }), 500); console.log('ocr ms', Date.now() - t)
t = Date.now(); const u = await call('uia', {}); show('uia', u, 700); console.log('uia ms', Date.now() - t, 'n=', u.result?.elements?.length)
p.kill(); process.exit(0)
