$d = 'C:\Users\aadmin\Downloads\Jarvis\voice'
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
foreach ($cfg in @(@(4,'1e-5'), @(12,'1e-5'), @(8,'5e-6'), @(8,'2e-5'), @(16,'5e-6'))) {
  $tag = "grid_u$($cfg[0])_lr$($cfg[1])"
  & "$d\.venv\Scripts\python.exe" -u "$d\ft_xtts.py" --out $tag --epochs 14 --unfreeze $cfg[0] --lr $cfg[1] --batch 3 2>$null | Select-String 'best eval' | ForEach-Object { "$tag $($_.Line)" } | Out-File -Append -Encoding utf8 "$d\grid.log"
}
'GRID DONE' | Out-File -Append -Encoding utf8 "$d\grid.log"
