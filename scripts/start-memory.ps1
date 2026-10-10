param([switch]$Foreground, [switch]$LocalSearch)
$ErrorActionPreference = 'Stop'
$previousApiKey = $env:HINDSIGHT_API_LLM_API_KEY
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$engine = Join-Path $workspace '.omnibrowser\hindsight-venv\Scripts\hindsight-api.exe'
if (-not (Test-Path -LiteralPath $engine)) { & (Join-Path $PSScriptRoot 'install-memory.ps1') }
try {
    $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:8888/health/ready' -TimeoutSec 2
    if ($ready.status -eq 'healthy' -or $ready.status -eq 'ok') { Write-Host 'Memory service is already running.'; exit 0 }
} catch {}
if ($LocalSearch) {
    $env:HINDSIGHT_API_LLM_PROVIDER = 'none'
    $env:HINDSIGHT_API_LLM_MODEL = 'none'
    Remove-Item Env:HINDSIGHT_API_LLM_API_KEY -ErrorAction SilentlyContinue
}
if (-not $env:HINDSIGHT_API_LLM_PROVIDER) { $env:HINDSIGHT_API_LLM_PROVIDER = 'openai' }
if (-not $env:HINDSIGHT_API_LLM_MODEL) { $env:HINDSIGHT_API_LLM_MODEL = 'gpt-4o-mini' }
if (-not $LocalSearch -and -not $env:HINDSIGHT_API_LLM_API_KEY -and $env:OPENAI_API_KEY) { $env:HINDSIGHT_API_LLM_API_KEY = $env:OPENAI_API_KEY }
if (-not $env:HINDSIGHT_API_LLM_API_KEY) {
    $env:HINDSIGHT_API_LLM_PROVIDER = 'none'
    $env:HINDSIGHT_API_LLM_MODEL = 'none'
    Write-Host 'Starting Hindsight local semantic search. Configure an AI provider key for fact extraction, consolidation and visual memory.'
}
if (-not $env:HINDSIGHT_API_EMBEDDINGS_PROVIDER) { $env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx' }
if (-not $env:HINDSIGHT_API_RERANKER_PROVIDER) { $env:HINDSIGHT_API_RERANKER_PROVIDER = 'flashrank' }
if (-not $env:HINDSIGHT_API_DATABASE_URL) { $env:HINDSIGHT_API_DATABASE_URL = 'pg0://omnibrowser-memory' }
$env:HINDSIGHT_API_WORKER_ID = 'omnibrowser-memory'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
if (-not $env:HINDSIGHT_API_MODEL_INIT_TIMEOUT) { $env:HINDSIGHT_API_MODEL_INIT_TIMEOUT = '1800' }
try {
    if ($Foreground) { & $engine --host 127.0.0.1 --port 8888 }
    else {
        $output = Join-Path $workspace '.omnibrowser\hindsight-output.log'
        $errors = Join-Path $workspace '.omnibrowser\hindsight-errors.log'
        $process = Start-Process -FilePath $engine -ArgumentList @('--host', '127.0.0.1', '--port', '8888') -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
        $process.Id | Set-Content -LiteralPath (Join-Path $workspace '.omnibrowser\hindsight.pid')
        Write-Host 'Hindsight is starting. The first run downloads its local search models.'
        Write-Host 'Reload the browser extension. Automatic memory saving connects to the local service when it is ready.'
        Write-Host "Startup logs: $errors"
    }
} finally {
    if ($previousApiKey) { $env:HINDSIGHT_API_LLM_API_KEY = $previousApiKey }
    else { Remove-Item Env:HINDSIGHT_API_LLM_API_KEY -ErrorAction SilentlyContinue }
}
