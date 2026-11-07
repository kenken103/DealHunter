$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/next/package.json'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}

& (Join-Path $PSScriptRoot 'start-backend.ps1')
if (-not $?) { throw 'Backend startup failed.' }

Write-Host 'DealHunter: http://127.0.0.1:3100'
try {
    $existingPage = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3100' -TimeoutSec 2
    if ($existingPage.Content -match '<title>[^<]*DealHunter') {
        Write-Host 'DealHunter frontend is already running.'
        return
    }
} catch { }
Write-Host 'Ctrl+C stops the frontend. To stop Java/PostgreSQL: ./scripts/stop-backend.ps1'
& npm.cmd run dev
exit $LASTEXITCODE
