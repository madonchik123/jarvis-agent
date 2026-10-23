// Real on-screen capture (including layered / transparent windows such as the HUD):
//   node --import tsx scripts/screen-shot.mts <out.png>
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const out = resolve(process.argv[2] || 'screen.png')
const p = spawn('resources/native/jarvis-native.exe', [], { stdio: ['pipe', 'pipe', 'inherit'] })
createInterface({ input: p.stdout }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.id === 0) p.stdin.write(JSON.stringify({ id: 1, cmd: 'screenshot', path: out, monitor: 'primary', layered: true }) + '\n')
  else {
    console.log(m.ok ? out : m.error)
    p.kill()
  }
})
