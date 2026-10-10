$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
    $executablePath = Join-Path $projectRoot '.omnibrowser-venv\Scripts\omnibrowser.exe'
    if (-not (Test-Path -LiteralPath $executablePath)) {
        throw 'Double-click Install OmniBrowser first, then run this setup again.'
    }
    Write-Host 'Connect OmniBrowser to your existing Chrome profile' -ForegroundColor Cyan
    Write-Host '1. In your normal Chrome, open chrome://extensions and enable Developer mode.'
    Write-Host 'If you loaded an older OmniBrowser extension, remove it before loading this version.'
    Write-Host '2. Click Load unpacked and select this folder:'
    Write-Host (Join-Path $projectRoot 'extensions\chrome') -ForegroundColor Yellow
    Write-Host '3. Open the OmniBrowser extension popup and click Connect.'
    & $executablePath install-host
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the extension connection.' }
    $configuration = @{ mcpServers = @{ omnibrowser = @{ command = $executablePath; args = @('--mcp', '--extension') } } }
    $configurationPath = Join-Path $projectRoot 'omnibrowser-mcp.json'
    $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configurationPath -Encoding UTF8
    Write-Host "`nSetup complete. Reload OmniBrowser if it was already loaded, then click Connect." -ForegroundColor Green
    Write-Host 'Use Copy AI connection settings in the popup to connect your AI app.'
    Write-Host "Add the settings from $configurationPath to your AI app, then restart its connection."
    Write-Host 'Use your normal Chrome. You do not need the separate OmniBrowser desktop shortcut.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
