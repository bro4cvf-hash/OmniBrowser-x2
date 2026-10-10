param([string]$Python)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$environment = Join-Path $workspace '.omnibrowser\hindsight-venv'
if (-not $Python) {
    $existing = Join-Path $workspace '.omnibrowser-venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $existing) { $Python = $existing }
    else { $Python = 'python' }
}
& $Python -c 'import sys; assert sys.version_info >= (3, 11), "Hindsight requires Python 3.11 or newer"'
if ($LASTEXITCODE -ne 0) { throw 'Select Python 3.11+ with -Python.' }
if (-not (Test-Path -LiteralPath (Join-Path $environment 'Scripts\python.exe'))) {
    & $Python -m venv $environment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the private memory environment.' }
}
$enginePython = Join-Path $environment 'Scripts\python.exe'
$packages = @('hindsight-api-slim[embedded-db,local-onnx]==0.10.3', 'flashrank>=0.2.0,<0.3')
if (Get-Command uv -ErrorAction SilentlyContinue) { & uv pip install --python $enginePython @packages }
else { & $enginePython -m pip install @packages }
if ($LASTEXITCODE -ne 0) { throw 'Hindsight installation failed.' }
Write-Host 'Hindsight 0.10.3 installed privately. Start it with Start Memory.cmd.'
