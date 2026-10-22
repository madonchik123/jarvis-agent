# Installs the cloned-Jarvis voice engine for the packaged app into %APPDATA%\Jarvis\clone
# (the dev checkout uses voice\ directly and needs no install).
#   powershell -ExecutionPolicy Bypass -File voice\install-clone.ps1
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:APPDATA 'Jarvis\clone'
New-Item -ItemType Directory -Force "$dst\refs" | Out-Null

Copy-Item "$src\xtts_server.py" $dst -Force
if (Test-Path "$src\gpt_best.pth") { Copy-Item "$src\gpt_best.pth" $dst -Force }
Copy-Item "$src\dataset\*.wav", "$src\dataset\metadata.json" "$dst\refs" -Force

if (-not (Test-Path "$dst\venv\Scripts\python.exe")) {
  python -m venv "$dst\venv"
  & "$dst\venv\Scripts\pip.exe" install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124
  & "$dst\venv\Scripts\pip.exe" install "coqui-tts==0.25.3" "transformers==4.46.2" "tokenizers<0.21" "numpy==1.26.4" soundfile scipy librosa
}
Write-Host "Done. Restart Jarvis and pick 'Jarvis - cloned from your clips' in Settings > Voice."
