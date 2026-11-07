param([string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $projectRoot '.local'
$apiProcessFile = Join-Path $localDir 'api-process.json'
if (Test-Path -LiteralPath $apiProcessFile) {
    $savedProcess = Get-Content -LiteralPath $apiProcessFile -Raw | ConvertFrom-Json
    $apiProcess = Get-Process -Id $savedProcess.id -ErrorAction SilentlyContinue
    # Verify the process start time too, so a recycled PID cannot stop an unrelated process.
    if ($apiProcess -and $apiProcess.ProcessName -eq 'java' -and $apiProcess.StartTime.ToUniversalTime().Ticks -eq $savedProcess.startTimeUtcTicks) {
        Stop-Process -Id $apiProcess.Id
    }
    Remove-Item -LiteralPath $apiProcessFile
}

if (-not $PostgresBin) {
    $pgCommand = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($pgCommand) { $PostgresBin = Split-Path -Parent $pgCommand.Source }
}
$pgData = Join-Path $localDir 'postgres'
if ($PostgresBin -and (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
    if ($LASTEXITCODE -eq 0) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData -m fast -w -t 20 stop | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not stop. See .local/postgres.log.' }
    }
}
Write-Output 'DealHunter Java API and isolated PostgreSQL stopped.'
