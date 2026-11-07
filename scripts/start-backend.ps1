param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
# npm launched from PowerShell 7 can pass its module paths to Windows
# PowerShell 5. Make the current runtime's built-in cmdlets discoverable.
$runtimeModules = Join-Path $PSHOME 'Modules'
$env:PSModulePath = $runtimeModules + [IO.Path]::PathSeparator + $env:PSModulePath
$projectRoot = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $projectRoot '.local'
$backendDir = Join-Path $projectRoot 'backend'
$pgData = Join-Path $localDir 'postgres'
$pgPasswordFile = Join-Path $localDir 'database.password'
$apiProcessFile = Join-Path $localDir 'api-process.json'
$apiKeyFile = Join-Path $localDir 'api-key'
New-Item -ItemType Directory -Force -Path $localDir | Out-Null

if (-not $JavaHome) {
    $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($javaCommand) { $JavaHome = Split-Path -Parent (Split-Path -Parent $javaCommand.Source) }
}
if (-not $PostgresBin) {
    $pgCommand = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($pgCommand) { $PostgresBin = Split-Path -Parent $pgCommand.Source }
}
if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
    throw 'JDK 21 or newer is required. Set JAVA_HOME to your JDK directory.'
}
if (-not $PostgresBin -or -not (Test-Path -LiteralPath (Join-Path $PostgresBin 'initdb.exe'))) {
    throw 'PostgreSQL is required. Set DEALHUNTER_POSTGRES_BIN to its bin directory.'
}

$driverPath = Join-Path $backendDir 'lib/postgresql-42.7.7.jar'
$driverHash = '157963D60AE66D607E09466E8C0CDF8087E9CB20D0159899FFCA96BCA2528460'
if (-not (Test-Path -LiteralPath $driverPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $driverPath) | Out-Null
    Invoke-WebRequest -Uri 'https://repo.maven.apache.org/maven2/org/postgresql/postgresql/42.7.7/postgresql-42.7.7.jar' -OutFile $driverPath -TimeoutSec 45
}
if ((Get-FileHash -LiteralPath $driverPath -Algorithm SHA256).Hash -ne $driverHash) {
    throw 'PostgreSQL JDBC driver checksum mismatch.'
}
$jsonDependencies = @(
    @{ Name='jackson-core'; Hash='056BC4D3E5E53CE821450FA97B3F9E0F8DDE125CF6DA6884353BB1F09582E1D9' },
    @{ Name='jackson-annotations'; Hash='8AA5740D80B5A5025508B41BBADBAA1FB3772267C628B2E30681A4F45F8B8931' },
    @{ Name='jackson-databind'; Hash='510BDDA75A7A6186C5BF33B851239488A1450906AE5757121F2E1CC48A7E108F' }
)
foreach ($dependency in $jsonDependencies) {
    $jarName = $dependency.Name + '-2.18.3.jar'
    $jarPath = Join-Path $backendDir ('lib/' + $jarName)
    if (-not (Test-Path -LiteralPath $jarPath)) {
        Invoke-WebRequest -UseBasicParsing -Uri ('https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/' + $dependency.Name + '/2.18.3/' + $jarName) -OutFile $jarPath -TimeoutSec 45
    }
    if ((Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash -ne $dependency.Hash) { throw "JDBC JSON dependency checksum mismatch: $jarName" }
}
if (-not (Test-Path -LiteralPath $apiKeyFile)) {
    [IO.File]::WriteAllText($apiKeyFile, [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'), [Text.UTF8Encoding]::new($false))
}

if (-not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
    if (-not (Test-Path -LiteralPath $pgPasswordFile)) {
        [IO.File]::WriteAllText($pgPasswordFile, [Guid]::NewGuid().ToString('N'), [Text.UTF8Encoding]::new($false))
    }
    & (Join-Path $PostgresBin 'initdb.exe') -D $pgData --username=dealhunter "--pwfile=$pgPasswordFile" --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the isolated PostgreSQL demo database.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $pgData 'global/pg_control'))) {
    throw 'The isolated PostgreSQL cluster initialization is incomplete. Check .local/postgres before retrying.'
}
if (-not (Test-Path -LiteralPath (Join-Path $pgData '.dealhunter-local'))) {
    @"

# DealHunter local demo only. Existing PostgreSQL installations are not changed.
listen_addresses = '127.0.0.1'
port = 55432
timezone = 'Asia/Tokyo'
max_connections = 30
shared_buffers = '32MB'
"@ | Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Encoding utf8
    New-Item -ItemType File -Path (Join-Path $pgData '.dealhunter-local') | Out-Null
}
if (-not (Test-Path -LiteralPath $pgPasswordFile)) { throw 'Local PostgreSQL password file is missing.' }

& (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
    # Detach pg_ctl from the calling shell's pipes so the server cannot retain them.
    $pgStart = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList @('-D', "`"$pgData`"", '-l', "`"$(Join-Path $localDir 'postgres.log')`"", '-w', '-t', '20', 'start') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDir 'pg-start.log') -RedirectStandardError (Join-Path $localDir 'pg-start-error.log') -PassThru
    # Start-Process -Wait waits for the entire process tree on Windows, including
    # the PostgreSQL daemon. WaitForExit waits only for pg_ctl itself.
    $pgStart.WaitForExit()
    # Windows PowerShell can lose ExitCode for very short-lived processes;
    # verify the actual cluster instead of relying on that process property.
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not start. See .local/postgres.log.' }
}

$oldPgPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = [IO.File]::ReadAllText($pgPasswordFile).Trim()
    $databaseExists = & (Join-Path $PostgresBin 'psql.exe') -h 127.0.0.1 -p 55432 -U dealhunter -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'dealhunter'"
    if ($LASTEXITCODE -ne 0) { throw 'Could not connect to isolated PostgreSQL.' }
    if ($databaseExists -ne '1') {
        & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p 55432 -U dealhunter --encoding=UTF8 dealhunter
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the DealHunter demo database.' }
    }
} finally {
    $env:PGPASSWORD = $oldPgPassword
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 2 -DisableKeepAlive
    if ($health.service -eq 'dealhunter' -and $health.status -eq 'ok' -and $health.version -eq 'workflow-v6' -and -not $Restart) {
        Write-Output 'DealHunter Java API already running: http://127.0.0.1:8080'
        return
    }
} catch { }
if (Test-Path -LiteralPath $apiProcessFile) {
    $savedApi = Get-Content -LiteralPath $apiProcessFile -Raw | ConvertFrom-Json
    $oldApi = Get-Process -Id $savedApi.id -ErrorAction SilentlyContinue
    if ($oldApi -and $oldApi.ProcessName -eq 'java' -and $oldApi.StartTime.ToUniversalTime().Ticks -eq $savedApi.startTimeUtcTicks) {
        Stop-Process -Id $oldApi.Id
        $oldApi.WaitForExit()
    }
}

$classesDir = Join-Path $backendDir 'build/classes'
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
& (Join-Path $JavaHome 'bin/javac.exe') -encoding UTF-8 --release 21 -cp (Join-Path $backendDir 'lib/*') -d $classesDir (Join-Path $backendDir 'src/DealHunterServer.java')
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }

$oldDatabasePassword = $env:DEALHUNTER_DATABASE_PASSWORD
$oldApiKey = $env:DEALHUNTER_API_KEY
try {
    $env:DEALHUNTER_DATABASE_PASSWORD = [IO.File]::ReadAllText($pgPasswordFile).Trim()
    $env:DEALHUNTER_API_KEY = [IO.File]::ReadAllText($apiKeyFile).Trim()
    $classPath = "$classesDir;$(Join-Path $backendDir 'lib/*')"
    $apiProcess = Start-Process -FilePath (Join-Path $JavaHome 'bin/java.exe') -ArgumentList @('-cp', "`"$classPath`"", 'DealHunterServer', "`"$backendDir`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDir 'api.log') -RedirectStandardError (Join-Path $localDir 'api-error.log') -PassThru
    @{ id = $apiProcess.Id; startTimeUtcTicks = $apiProcess.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -LiteralPath $apiProcessFile
} finally {
    $env:DEALHUNTER_DATABASE_PASSWORD = $oldDatabasePassword
    $env:DEALHUNTER_API_KEY = $oldApiKey
}

$lastHealthError = ''
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 1 -DisableKeepAlive
        if ($health.service -eq 'dealhunter' -and $health.status -eq 'ok' -and $health.version -eq 'workflow-v6') {
            Write-Output 'DealHunter Java API ready: http://127.0.0.1:8080 (PostgreSQL port 55432)'
            return
        }
    } catch { $lastHealthError = $_.Exception.Message }
    if ($apiProcess.HasExited) { break }
}
throw ('Java API did not become ready. See .local/api-error.log. ' + $lastHealthError)
