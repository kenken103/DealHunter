param(
    [Parameter(Mandatory = $true)][ValidateSet('Backup', 'Restore')][string]$Action,
    [string]$BackupPath,
    [string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN,
    [ValidateRange(1024, 65535)][int]$PostgresPort = 15432
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $projectRoot '.local'
$pgData = Join-Path $localDir 'postgres'
if (-not $BackupPath) { $BackupPath = Join-Path $localDir 'dealhunter-data.dump' }
$archivePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BackupPath)

if (-not $PostgresBin) {
    $pgCommand = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($pgCommand) { $PostgresBin = Split-Path -Parent $pgCommand.Source }
}
if (-not $PostgresBin) { throw 'PostgreSQL 17 is required. Set DEALHUNTER_POSTGRES_BIN to its bin directory.' }
$psql = Join-Path $PostgresBin 'psql.exe'
$pgDump = Join-Path $PostgresBin 'pg_dump.exe'
$pgRestore = Join-Path $PostgresBin 'pg_restore.exe'
foreach ($program in @($psql, $pgDump, $pgRestore)) {
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw "PostgreSQL tool not found: $program" }
}

if ($Action -eq 'Backup' -and -not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    throw 'No local DealHunter database exists to back up.'
}
if ($Action -eq 'Restore') {
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Backup file not found: $archivePath" }
    $archiveContents = & $pgRestore --list $archivePath
    if ($LASTEXITCODE -ne 0 -or -not ($archiveContents -match ' TABLE DATA public app_users ') -or -not ($archiveContents -match ' TABLE DATA public projects ')) {
        throw 'This file is not a DealHunter database archive.'
    }
}

& (Join-Path $PSScriptRoot 'start-backend.ps1') -DatabaseOnly -PostgresBin $PostgresBin -PostgresPort $PostgresPort

$connection = @('--host=127.0.0.1', "--port=$PostgresPort", '--username=dealhunter', '--dbname=dealhunter', '--no-password')
function Get-DatabaseValue([string]$Sql) {
    $value = & $psql @connection -X -qAt -v ON_ERROR_STOP=1 --command $Sql
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the local DealHunter database.' }
    return $value
}

$oldPassword = $env:PGPASSWORD
$oldConnectTimeout = $env:PGCONNECT_TIMEOUT
try {
    $env:PGPASSWORD = [IO.File]::ReadAllText((Join-Path $localDir 'database.password')).Trim()
    $env:PGCONNECT_TIMEOUT = '5'
    $serverData = Get-DatabaseValue 'SHOW data_directory'
    if ([IO.Path]::GetFullPath($serverData) -ne [IO.Path]::GetFullPath($pgData)) {
        throw 'The PostgreSQL server does not belong to this checkout.'
    }

    if ($Action -eq 'Restore') {
        $hasObjects = Get-DatabaseValue "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace)"
        if ($hasObjects -ne 'f') {
            throw 'The destination database is already initialized. Restore into a fresh checkout before running the demo.'
        }
        & $pgRestore @connection --no-owner --no-privileges --exit-on-error --single-transaction $archivePath
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore the DealHunter database.' }
        Write-Output "DealHunter data restored from: $archivePath"
        return
    }

    $hasSchema = Get-DatabaseValue "SELECT to_regclass('public.app_users') IS NOT NULL AND to_regclass('public.projects') IS NOT NULL"
    if ($hasSchema -ne 't') { throw 'No initialized DealHunter database exists to back up.' }
    $archiveDir = [IO.Path]::GetDirectoryName($archivePath)
    [IO.Directory]::CreateDirectory($archiveDir) | Out-Null
    $pendingArchive = Join-Path $archiveDir ('.dealhunter-' + [Guid]::NewGuid().ToString('N') + '.dump')
    try {
        & $pgDump @connection --format=custom --no-owner --no-privileges --file $pendingArchive
        if ($LASTEXITCODE -ne 0) { throw 'Could not back up the DealHunter database.' }
        if ([IO.File]::Exists($archivePath)) {
            [IO.File]::Replace($pendingArchive, $archivePath, [NullString]::Value)
        } else {
            [IO.File]::Move($pendingArchive, $archivePath)
        }
    } finally {
        if (Test-Path -LiteralPath $pendingArchive -PathType Leaf) { Remove-Item -LiteralPath $pendingArchive }
    }
    Write-Output "DealHunter backup saved to: $archivePath"
} finally {
    $env:PGPASSWORD = $oldPassword
    $env:PGCONNECT_TIMEOUT = $oldConnectTimeout
}
