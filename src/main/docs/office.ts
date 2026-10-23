// Uses the Office apps already installed on the PC (Word / PowerPoint / Excel via COM, or LibreOffice) for exact
// conversions — PDF export, old formats (.doc/.ppt/.xls/.rtf/.odt) to OOXML, PDF → DOCX through Word — and to refresh
// the table of contents of generated documents so it gets real page numbers.
import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { extname, dirname, basename, join } from 'path'

function ps(script: string, env: Record<string, string>, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: { ...process.env, ...env } })
    let out = ''
    let errOut = ''
    const t = setTimeout(() => {
      p.kill()
      reject(new Error('Office did not finish in time (is a dialog open in Word/PowerPoint?)'))
    }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (errOut += d))
    p.on('close', (code) => {
      clearTimeout(t)
      if (code === 0 && !/JARVIS_FAIL/.test(out)) resolve(out.trim())
      else reject(new Error((out.match(/JARVIS_FAIL:(.*)/)?.[1] || errOut || `exit ${code}`).trim().slice(0, 400)))
    })
  })
}

let apps: Promise<{ word: boolean; powerpoint: boolean; excel: boolean; soffice: string }> | null = null
export function officeApps() {
  apps ??= (async () => {
    const r = await ps(
      "foreach ($n in 'Word.Application','PowerPoint.Application','Excel.Application') { if ([type]::GetTypeFromProgID($n)) { $n } }",
      {},
      20_000
    ).catch(() => '')
    const so = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find((p) => existsSync(p)) ?? ''
    return { word: /Word/.test(r), powerpoint: /PowerPoint/.test(r), excel: /Excel/.test(r), soffice: so }
  })()
  return apps
}

const WORD = `
$ErrorActionPreference = 'Stop'
$w = $null
# Word COM wants [ref] arguments from PowerShell 5.1
$no = 0
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$mine = @()
try {
  $w = New-Object -ComObject Word.Application
  $mine = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  $w.Visible = $false; $w.DisplayAlerts = 0
  $fn = [string]$env:J_IN; $conf = $false; $ro = ($env:J_MODE -ne 'toc'); $rec = $false
  $d = $w.Documents.Open([ref]$fn, [ref]$conf, [ref]$ro, [ref]$rec)
  if ($env:J_MODE -eq 'toc') {
    foreach ($t in $d.TablesOfContents) { $t.Update() }
    $d.Fields.Update() | Out-Null
    $d.Save()
  } else {
    foreach ($t in $d.TablesOfContents) { $t.UpdatePageNumbers() }
    $o = [string]$env:J_OUT; $f = [int]$env:J_FMT; $d.SaveAs2([ref]$o, [ref]$f)
  }
  $d.Close([ref]$no)
  'ok'
} catch { 'JARVIS_FAIL:' + $_.Exception.Message } finally { if ($w) { try { $w.Quit([ref]$no) | Out-Null } catch { foreach ($id in $mine) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }; [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null } }
`
const POWERPOINT = `
$ErrorActionPreference = 'Stop'
$p = $null
# never quit an instance the user already had open (PowerPoint attaches to it)
$had = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
try {
  $p = New-Object -ComObject PowerPoint.Application
  $pr = $p.Presentations.Open($env:J_IN, -1, 0, 0)
  $o = [string]$env:J_OUT; $f = [int]$env:J_FMT; $pr.SaveAs($o, $f)
  $pr.Close()
  'ok'
} catch { 'JARVIS_FAIL:' + $_.Exception.Message } finally { if ($p) { if (-not $had) { $p.Quit() | Out-Null }; [Runtime.InteropServices.Marshal]::ReleaseComObject($p) | Out-Null } }
`
const EXCEL = `
$ErrorActionPreference = 'Stop'
$x = $null
try {
  $x = New-Object -ComObject Excel.Application
  $x.Visible = $false; $x.DisplayAlerts = $false
  $b = $x.Workbooks.Open($env:J_IN, 0, $true)
  if ($env:J_FMT -eq 'pdf') { $b.ExportAsFixedFormat(0, $env:J_OUT) } else { $b.SaveAs($env:J_OUT, 51) }
  $b.Close($false)
  'ok'
} catch { 'JARVIS_FAIL:' + $_.Exception.Message } finally { if ($x) { $x.Quit() | Out-Null; [Runtime.InteropServices.Marshal]::ReleaseComObject($x) | Out-Null } }
`

/** Word fills the TOC (real page numbers) and saves; silently skipped when Word isn't installed. */
export async function refreshToc(docx: string): Promise<boolean> {
  if (!(await officeApps()).word) return false
  await ps(WORD, { J_IN: docx, J_MODE: 'toc' })
  return true
}

export type Target = 'pdf' | 'docx' | 'pptx' | 'xlsx'

export async function convertWithOffice(input: string, to: Target, out: string): Promise<string> {
  const ext = extname(input).toLowerCase()
  const a = await officeApps()
  const wordIn = ['.docx', '.doc', '.docm', '.rtf', '.odt', '.txt', '.htm', '.html', '.pdf']
  const pptIn = ['.pptx', '.ppt', '.pptm', '.odp']
  const xlsIn = ['.xlsx', '.xls', '.xlsm', '.ods', '.csv']
  if (a.word && wordIn.includes(ext) && (to === 'pdf' || to === 'docx')) {
    await ps(WORD, { J_IN: input, J_OUT: out, J_MODE: 'save', J_FMT: to === 'pdf' ? '17' : '16' })
    return 'Word'
  }
  if (a.powerpoint && pptIn.includes(ext) && (to === 'pdf' || to === 'pptx')) {
    await ps(POWERPOINT, { J_IN: input, J_OUT: out, J_FMT: to === 'pdf' ? '32' : '24' })
    return 'PowerPoint'
  }
  if (a.excel && xlsIn.includes(ext) && (to === 'pdf' || to === 'xlsx')) {
    await ps(EXCEL, { J_IN: input, J_OUT: out, J_FMT: to })
    return 'Excel'
  }
  if (a.soffice && ext !== '.pdf') {
    const outDir = dirname(out)
    await new Promise<void>((resolve, reject) => {
      const p = spawn(a.soffice, ['--headless', '--convert-to', to, '--outdir', outDir, input], { windowsHide: true })
      const t = setTimeout(() => (p.kill(), reject(new Error('LibreOffice timed out'))), 180_000)
      p.on('close', (c) => (clearTimeout(t), c === 0 ? resolve() : reject(new Error('LibreOffice failed'))))
    })
    const produced = join(outDir, basename(input, ext) + '.' + to)
    if (produced !== out && existsSync(produced)) {
      const { renameSync } = await import('fs')
      renameSync(produced, out)
    }
    if (existsSync(out) && statSync(out).size > 0) return 'LibreOffice'
  }
  throw new Error('no-office')
}
