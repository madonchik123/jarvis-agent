// Copies files the app ships but does not build itself:
//  - the Visual C++ runtime DLLs Piper needs → resources/native/vcrt (Piper runs with that folder on PATH, so voices work
//    on PCs without the VC++ redistributable; these three files are app-local redistributable per Microsoft's terms)
//  - Mermaid's self-contained browser bundle → resources/vendor (diagram rendering; the npm package's deps are not shipped)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const vc = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const sys = join(process.env.SystemRoot || 'C:\Windows', 'System32')
mkdirSync(join('resources', 'native', 'vcrt'), { recursive: true })
for (const f of vc) {
  if (!existsSync(join(sys, f))) {
    console.error(`vendor: ${join(sys, f)} not found — install the VC++ 2015-2022 x64 redistributable on the build machine`)
    process.exit(1)
  }
  copyFileSync(join(sys, f), join('resources', 'native', 'vcrt', f))
}

const mermaid = join('node_modules', 'mermaid', 'dist', 'mermaid.min.js')
if (!existsSync(mermaid)) {
  console.error('vendor: mermaid is missing — run npm install')
  process.exit(1)
}
mkdirSync(join('resources', 'vendor'), { recursive: true })
copyFileSync(mermaid, join('resources', 'vendor', 'mermaid.min.js'))
console.log('vendor: VC++ runtime + mermaid copied')
