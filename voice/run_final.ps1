$d = 'C:\Users\aadmin\Downloads\Jarvis\voice'
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
$env:GPT='grid_u16_lr5e-6/gpt_best.pth'; $env:TAG='u16'
& "$d\.venv\Scripts\python.exe" -u "$d\eval_ft2.py" 2>$null | Select-String 'mel-dist|done' | ForEach-Object { $_.Line } | Out-File -Encoding utf8 "$d\evalu16.log"
& "$d\.venv\Scripts\python.exe" -u "$d\ft_xtts.py" --out final_all --epochs 11 --unfreeze 16 --lr 5e-6 --batch 3 --all-data 2>$null | Select-String 'epoch|best' | ForEach-Object { $_.Line } | Out-File -Encoding utf8 "$d\final.log"
'FINAL DONE' | Out-File -Append -Encoding utf8 "$d\final.log"
