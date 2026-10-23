# Memory of a running Jarvis, grouped by process kind:  powershell -File scripts/mem.ps1
$all = Get-CimInstance Win32_Process
$roots = $all | Where-Object { ($_.Name -match '^(electron|Jarvis)\.exe$') -and ($_.CommandLine -match 'Jarvis') -and -not ($_.CommandLine -match '--type=') }
if (-not $roots) { Write-Host 'Jarvis is not running'; exit }
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($r in $roots) { [void]$ids.Add([int]$r.ProcessId) }
do {
  $added = $false
  foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } }
} while ($added)
$rows = foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $cl = ($all | Where-Object { $_.ProcessId -eq $id }).CommandLine
  $kind = $p.ProcessName
  if ($cl -match '--type=([a-z-]+)') { $kind = "$($p.ProcessName):$($Matches[1])" }
  if ($cl -match 'asrChild|asr\.js') { $kind = 'asr-child' }
  [pscustomobject]@{ Kind = $kind; PID = $id; WorkingSetMB = [math]::Round($p.WorkingSet64 / 1MB); PrivateMB = [math]::Round($p.PrivateMemorySize64 / 1MB) }
}
$rows | Sort-Object PrivateMB -Descending | Format-Table -AutoSize
'TOTAL working set: {0} MB   private: {1} MB' -f ($rows | Measure-Object WorkingSetMB -Sum).Sum, ($rows | Measure-Object PrivateMB -Sum).Sum
