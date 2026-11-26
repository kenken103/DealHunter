param(
    [Parameter(Mandatory = $true)][ValidateSet('Backup', 'Restore', 'Snapshot')][string]$Action,
    [string]$BackupPath,
    [string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN,
    [ValidateRange(1024, 65535)][int]$PostgresPort = 15432
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $projectRoot '.local'
$pgData = Join-Path $localDir 'postgres'
$plainArchive = Join-Path $localDir 'dealhunter-data.dump'
$bundledArchive = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data/dealhunter-data.dump.enc'))
$keyPath = Join-Path $localDir 'dealhunter-data.key'
$cryptoScript = Join-Path $PSScriptRoot 'demo-data-crypto.mjs'
if ($Action -eq 'Snapshot') {
    if ($BackupPath) { throw 'The repository snapshot has a fixed output path.' }
    if ((Test-Path -LiteralPath $bundledArchive -PathType Leaf) -and -not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
        throw 'The original recovery key is required to update the existing repository snapshot.'
    }
    $BackupPath = $bundledArchive
} elseif (-not $BackupPath) {
    $BackupPath = $plainArchive
    if ($Action -eq 'Restore' -and -not (Test-Path -LiteralPath $plainArchive -PathType Leaf) -and
        (Test-Path -LiteralPath $bundledArchive -PathType Leaf)) {
        $BackupPath = $bundledArchive
    }
}
$archivePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BackupPath)
if ($Action -eq 'Backup' -and $archivePath -eq $bundledArchive) {
    throw 'The repository snapshot path is reserved for encrypted backups. Use db:snapshot.'
}
if ($archivePath -eq $keyPath) { throw 'Choose a path other than the database recovery key.' }

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

if ($Action -ne 'Restore' -and -not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    throw 'No local DealHunter database exists to back up.'
}

$connection = @('--host=127.0.0.1', "--port=$PostgresPort", '--username=dealhunter', '--dbname=dealhunter', '--no-password')
function Get-DatabaseValue([string]$Sql) {
    $value = & $psql @connection -X -qAt -v ON_ERROR_STOP=1 --command $Sql
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the local DealHunter database.' }
    return $value
}

function Test-SnapshotHeader([string]$Path) {
    $prefix = 'DealHunter-DB-'
    $header = New-Object byte[] $prefix.Length
    $stream = [IO.File]::OpenRead($Path)
    try {
        return $stream.Read($header, 0, $header.Length) -eq $header.Length -and
            [Text.Encoding]::ASCII.GetString($header) -ceq $prefix
    } finally {
        $stream.Dispose()
    }
}

$oldPassword = $env:PGPASSWORD
$oldConnectTimeout = $env:PGCONNECT_TIMEOUT
$temporaryArchive = $null
try {
    if ($Action -eq 'Restore') {
        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "Backup file not found: $archivePath" }
        $restoreArchive = $archivePath
        if ($archivePath -eq $bundledArchive -or (Test-SnapshotHeader $archivePath)) {
            if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw "Database recovery key not found: $keyPath" }
            $temporaryArchive = Join-Path $localDir ('.dealhunter-restore-' + [Guid]::NewGuid().ToString('N') + '.dump')
            & node $cryptoScript import $archivePath $temporaryArchive $keyPath
            if ($LASTEXITCODE -ne 0) { throw 'Could not decrypt the DealHunter database snapshot.' }
            $restoreArchive = $temporaryArchive
        }
        $archiveContents = & $pgRestore --list $restoreArchive
        if ($LASTEXITCODE -ne 0 -or -not ($archiveContents -match ' TABLE DATA public app_users ') -or -not ($archiveContents -match ' TABLE DATA public projects ')) {
            throw 'This file is not a DealHunter database archive.'
        }
    }

    & (Join-Path $PSScriptRoot 'start-backend.ps1') -DatabaseOnly -PostgresBin $PostgresBin -PostgresPort $PostgresPort
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
        & $pgRestore @connection --no-owner --no-privileges --exit-on-error --single-transaction $restoreArchive
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore the DealHunter database.' }
        Write-Output "DealHunter data restored from: $archivePath"
        return
    }

    $hasSchema = Get-DatabaseValue "SELECT to_regclass('public.app_users') IS NOT NULL AND to_regclass('public.projects') IS NOT NULL"
    if ($hasSchema -ne 't') { throw 'No initialized DealHunter database exists to back up.' }
    $archiveDir = [IO.Path]::GetDirectoryName($archivePath)
    [IO.Directory]::CreateDirectory($archiveDir) | Out-Null
    $temporaryDir = if ($Action -eq 'Snapshot') { $localDir } else { $archiveDir }
    $temporaryArchive = Join-Path $temporaryDir ('.dealhunter-' + [Guid]::NewGuid().ToString('N') + '.dump')
    & $pgDump @connection --format=custom --no-owner --no-privileges --file $temporaryArchive
    if ($LASTEXITCODE -ne 0) { throw 'Could not back up the DealHunter database.' }
    if ($Action -eq 'Snapshot') {
        & node $cryptoScript export $temporaryArchive $archivePath $keyPath
        if ($LASTEXITCODE -ne 0) { throw 'Could not encrypt the DealHunter database snapshot.' }
        Write-Output "Encrypted DealHunter snapshot saved to: $archivePath"
        Write-Output "Recovery key saved outside Git: $keyPath"
    } else {
        if ([IO.File]::Exists($archivePath)) {
            [IO.File]::Replace($temporaryArchive, $archivePath, [NullString]::Value)
        } else {
            [IO.File]::Move($temporaryArchive, $archivePath)
        }
        Write-Output "DealHunter backup saved to: $archivePath"
    }
} finally {
    $env:PGPASSWORD = $oldPassword
    $env:PGCONNECT_TIMEOUT = $oldConnectTimeout
    if ($temporaryArchive -and (Test-Path -LiteralPath $temporaryArchive -PathType Leaf)) {
        Remove-Item -LiteralPath $temporaryArchive
    }
}
