// Copies the Visual C++ runtime DLLs Piper needs into resources/native/vcrt so they ship with the app.
// Piper is started with that folder on PATH, so it works on PCs without the VC++ redistributable.
// (These three files are app-local redistributable per Microsoft's VC++ redist terms.)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const files = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
const src = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
const out = join('resources', 'native', 'vcrt')
mkdirSync(out, { recursive: true })
for (const f of files) {
  const from = join(src, f)
  if (!existsSync(from)) {
    console.error(`vcrt: ${from} not found — install the VC++ 2015-2022 x64 redistributable on the build machine`)
    process.exit(1)
  }
  copyFileSync(from, join(out, f))
}
console.log(`vcrt: copied ${files.length} files to ${out}`)
