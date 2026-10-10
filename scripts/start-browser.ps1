$ErrorActionPreference = 'Stop'
try {
    $chromePaths = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $chromePath = $chromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $chromePath) { throw 'Google Chrome was not found. Install Chrome, then open this shortcut again.' }
    $profilePath = Join-Path $env:LOCALAPPDATA 'OmniBrowser\Chrome'
    # Chrome is the user-facing interactive application this shortcut opens.
    Start-Process -FilePath $chromePath -ArgumentList @('--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', ('--user-data-dir="' + $profilePath + '"'))
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
