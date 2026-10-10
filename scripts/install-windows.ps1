param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
    Write-Host 'Setting up OmniBrowser x2...' -ForegroundColor Cyan
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    $pythonCandidates = @()
    if ($PythonPath) { $pythonCandidates += $PythonPath }
    $pythonCandidates += Join-Path $projectRoot '.omnibrowser-venv\Scripts\python.exe'
    $pythonInstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $pythonInstallRoot) {
        $pythonCandidates += Get-ChildItem -LiteralPath $pythonInstallRoot -Directory |
            Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' }
    }
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    $selectedPython = $null
    foreach ($candidate in $pythonCandidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        & $candidate -c "import sys; sys.exit(0 if sys.version_info >= (3, 10, 1) else 1)"
        if ($LASTEXITCODE -eq 0) { $selectedPython = $candidate; break }
    }
    if (-not $selectedPython) { throw 'Install a current Python version from python.org, enable Add Python to PATH, then run this installer again.' }
    $environmentPath = Join-Path $projectRoot '.omnibrowser-venv'
    $pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $pythonPath)) {
        & $selectedPython -m venv $environmentPath
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
    }
    & $pythonPath -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'Could not update pip. Check your internet connection and try again.' }
    & $pythonPath -m pip install -e "${projectRoot}[documents]"
    if ($LASTEXITCODE -ne 0) { throw 'Could not install OmniBrowser. Check the installation message above.' }
    $executablePath = Join-Path $environmentPath 'Scripts\omnibrowser.exe'
    & $executablePath --help
    if ($LASTEXITCODE -ne 0) { throw 'The installation check failed.' }
    & $pythonPath -c "from omnibrowser.mcp.server import create_server; create_server(extension=True)"
    if ($LASTEXITCODE -ne 0) { throw 'The AI server could not start. Check that your Python version is up to date.' }
    & $executablePath install-host
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the Chrome extension connection.' }
    $configuration = @{ mcpServers = @{ omnibrowser = @{ command = $executablePath; args = @('--mcp', '--extension') } } }
    $configurationPath = Join-Path $projectRoot 'omnibrowser-mcp.json'
    if (Test-Path -LiteralPath $configurationPath) {
        try {
            $previousConfiguration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
            if ($previousConfiguration.mcpServers.omnibrowser.args) {
                $configuration.mcpServers.omnibrowser.args = @($previousConfiguration.mcpServers.omnibrowser.args)
            }
        } catch { Write-Host 'Replacing unreadable connection settings.' }
    }
    $configuration | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configurationPath -Encoding UTF8
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktopPath 'OmniBrowser x2.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start-browser.ps1') + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = 'Open Chrome for OmniBrowser x2 automation'
    $shortcut.Save()
    Write-Host "`nInstalled! Double-click Connect Existing Chrome.cmd to use your normal Chrome profile." -ForegroundColor Green
    Write-Host 'The OmniBrowser x2 desktop shortcut is also available for a separate automation profile.'
    Write-Host "Your AI app connection settings are saved in: $configurationPath"
    Write-Host 'Add those settings to your AI app once. Keep this project folder in its current location.'
} catch {
    Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
