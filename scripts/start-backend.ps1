param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN,
    [switch]$Restart,
    [switch]$DatabaseOnly,
    [ValidateRange(1024, 65535)][int]$PostgresPort = 15432
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
$databaseUrl = "jdbc:postgresql://127.0.0.1:$postgresPort/dealhunter"
New-Item -ItemType Directory -Force -Path $localDir | Out-Null

function Update-LocalPostgresPort {
    param([string]$ConfigurationPath, [int]$CurrentPort, [int]$TargetPort, [bool]$IsRunning)

    if ($CurrentPort -eq $TargetPort) { return }
    if ($IsRunning) {
        throw "The DealHunter database is running on port $CurrentPort. Run ./scripts/stop-backend.ps1, then retry npm.cmd run demo to migrate it to port $TargetPort."
    }
    if ($CurrentPort -ne 55432) {
        throw "Unexpected local PostgreSQL port $CurrentPort. Review the local database configuration before changing it to $TargetPort."
    }

    $configuration = [IO.File]::ReadAllText($ConfigurationPath)
    $portSetting = [regex]::new('(?m)^([ \t]*port[ \t]*=[ \t]*)55432([ \t]*(?:#[^\r\n]*)?\r?)$')
    if ($portSetting.Matches($configuration).Count -ne 1) {
        throw 'The legacy PostgreSQL port setting could not be identified uniquely. The database configuration was not changed.'
    }
    $backupPath = $ConfigurationPath + '.before-port-change-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak'
    Copy-Item -LiteralPath $ConfigurationPath -Destination $backupPath -ErrorAction Stop
    $updatedConfiguration = $portSetting.Replace($configuration, '${1}' + $TargetPort + '${2}')
    [IO.File]::WriteAllText($ConfigurationPath, $updatedConfiguration, [Text.UTF8Encoding]::new($false))
    Write-Output "DealHunter PostgreSQL port migrated: $CurrentPort -> $TargetPort. Configuration backup: $backupPath"
}

if (-not $PostgresBin) {
    $pgCommand = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($pgCommand) { $PostgresBin = Split-Path -Parent $pgCommand.Source }
}
if (-not $PostgresBin -or -not (Test-Path -LiteralPath (Join-Path $PostgresBin 'initdb.exe'))) {
    throw 'PostgreSQL is required. Set DEALHUNTER_POSTGRES_BIN to its bin directory.'
}

if (-not $DatabaseOnly) {
    if (-not $JavaHome) {
        $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
        if ($javaCommand) { $JavaHome = Split-Path -Parent (Split-Path -Parent $javaCommand.Source) }
    }
    if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
        throw 'JDK 21 or newer is required. Set JAVA_HOME to your JDK directory.'
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
port = $postgresPort
timezone = 'Asia/Tokyo'
max_connections = 30
shared_buffers = '32MB'
"@ | Add-Content -LiteralPath (Join-Path $pgData 'postgresql.conf') -Encoding utf8
    New-Item -ItemType File -Path (Join-Path $pgData '.dealhunter-local') | Out-Null
}
if (-not (Test-Path -LiteralPath $pgPasswordFile)) { throw 'Local PostgreSQL password file is missing.' }

& (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
$postgresRunning = $LASTEXITCODE -eq 0
$configuredPort = & (Join-Path $PostgresBin 'postgres.exe') -D $pgData -C port
if ($LASTEXITCODE -ne 0 -or $configuredPort -notmatch '^\d+$') { throw 'Could not read the isolated PostgreSQL port.' }
Update-LocalPostgresPort -ConfigurationPath (Join-Path $pgData 'postgresql.conf') -CurrentPort ([int]$configuredPort) -TargetPort $postgresPort -IsRunning $postgresRunning
if ([int]$configuredPort -ne $postgresPort) {
    $effectivePort = & (Join-Path $PostgresBin 'postgres.exe') -D $pgData -C port
    if ($LASTEXITCODE -ne 0 -or $effectivePort -ne [string]$postgresPort) { throw 'The PostgreSQL port is overridden by another configuration. See .local/postgres/postgresql.conf and postgresql.auto.conf.' }
}
if (-not $postgresRunning) {
    # Detach pg_ctl from the calling shell's pipes so the server cannot retain them.
    $pgStart = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList @('-D', "`"$pgData`"", '-l', "`"$(Join-Path $localDir 'postgres.log')`"", '-w', '-t', '20', 'start') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDir 'pg-start.log') -RedirectStandardError (Join-Path $localDir 'pg-start-error.log') -PassThru
    # Start-Process -Wait waits for the entire process tree on Windows, including
    # the PostgreSQL daemon. WaitForExit waits only for pg_ctl itself.
    $pgStart.WaitForExit()
    # Windows PowerShell can lose ExitCode for very short-lived processes;
    # verify the actual cluster instead of relying on that process property.
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL did not start on port $postgresPort. See .local/postgres.log. Check that the port is available and outside Windows excluded TCP port ranges." }
}

$oldPgPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = [IO.File]::ReadAllText($pgPasswordFile).Trim()
    $databaseExists = & (Join-Path $PostgresBin 'psql.exe') -h 127.0.0.1 -p $postgresPort -U dealhunter -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'dealhunter'"
    if ($LASTEXITCODE -ne 0) { throw 'Could not connect to isolated PostgreSQL.' }
    if ($databaseExists -ne '1') {
        & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p $postgresPort -U dealhunter --encoding=UTF8 dealhunter
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the DealHunter demo database.' }
    }
} finally {
    $env:PGPASSWORD = $oldPgPassword
}

if ($DatabaseOnly) {
    Write-Output "DealHunter PostgreSQL ready: 127.0.0.1:$postgresPort"
    return
}

$javaSources = @(Get-ChildItem -LiteralPath (Join-Path $backendDir 'src') -Filter '*.java' -File | Sort-Object Name | ForEach-Object { $_.FullName })
$apiInputs = $javaSources + @('schema.sql', 'seed-users.sql', 'dashboard.sql' | ForEach-Object { Join-Path $backendDir $_ })
$larkConfig = Join-Path $localDir 'lark-calendar.json'
if (Test-Path -LiteralPath $larkConfig -PathType Leaf) { $apiInputs += $larkConfig }
$apiInputs += @(Get-ChildItem -LiteralPath (Join-Path $backendDir 'lib') -Filter '*.jar' -File | Sort-Object Name | ForEach-Object { $_.FullName })
# These inputs are compiled or loaded at startup. The API contract version can stay the same across changes.
$apiFingerprint = (Get-FileHash -LiteralPath $apiInputs -Algorithm SHA256).Hash -join ':'
$savedApi = $null
$oldApi = $null
if (Test-Path -LiteralPath $apiProcessFile) {
    $savedApi = Get-Content -LiteralPath $apiProcessFile -Raw | ConvertFrom-Json
    $oldApi = Get-Process -Id $savedApi.id -ErrorAction SilentlyContinue
    if ($oldApi -and ($oldApi.ProcessName -ne 'java' -or $oldApi.StartTime.ToUniversalTime().Ticks -ne $savedApi.startTimeUtcTicks)) { $oldApi = $null }
}
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 2 -DisableKeepAlive
    if ($oldApi -and $savedApi.databaseUrl -eq $databaseUrl -and $savedApi.inputFingerprint -eq $apiFingerprint -and
        $health.service -eq 'dealhunter' -and $health.status -eq 'ok' -and $health.version -eq 'workflow-v13' -and -not $Restart) {
        Write-Output 'DealHunter Java API already running: http://127.0.0.1:8080'
        return
    }
} catch { }
if ($oldApi) {
    Stop-Process -Id $oldApi.Id
    $oldApi.WaitForExit()
}

$classesDir = Join-Path $backendDir 'build/classes'
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
& (Join-Path $JavaHome 'bin/javac.exe') -encoding UTF-8 --release 21 -cp (Join-Path $backendDir 'lib/*') -d $classesDir @javaSources
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }

$oldDatabasePassword = $env:DEALHUNTER_DATABASE_PASSWORD
$oldDatabaseUrl = $env:DEALHUNTER_DATABASE_URL
$oldApiKey = $env:DEALHUNTER_API_KEY
$oldLocalDemo = $env:DEALHUNTER_LOCAL_DEMO
try {
    $env:DEALHUNTER_DATABASE_PASSWORD = [IO.File]::ReadAllText($pgPasswordFile).Trim()
    $env:DEALHUNTER_DATABASE_URL = $databaseUrl
    $env:DEALHUNTER_API_KEY = [IO.File]::ReadAllText($apiKeyFile).Trim()
    $env:DEALHUNTER_LOCAL_DEMO = '1'
    $classPath = "$classesDir;$(Join-Path $backendDir 'lib/*')"
    $apiProcess = Start-Process -FilePath (Join-Path $JavaHome 'bin/java.exe') -ArgumentList @('-cp', "`"$classPath`"", 'DealHunterServer', "`"$backendDir`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localDir 'api.log') -RedirectStandardError (Join-Path $localDir 'api-error.log') -PassThru
    @{ id = $apiProcess.Id; startTimeUtcTicks = $apiProcess.StartTime.ToUniversalTime().Ticks; databaseUrl = $databaseUrl; inputFingerprint = $apiFingerprint } | ConvertTo-Json | Set-Content -LiteralPath $apiProcessFile
} finally {
    $env:DEALHUNTER_DATABASE_PASSWORD = $oldDatabasePassword
    $env:DEALHUNTER_DATABASE_URL = $oldDatabaseUrl
    $env:DEALHUNTER_API_KEY = $oldApiKey
    $env:DEALHUNTER_LOCAL_DEMO = $oldLocalDemo
}

$lastHealthError = ''
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 1 -DisableKeepAlive
        if ($health.service -eq 'dealhunter' -and $health.status -eq 'ok' -and $health.version -eq 'workflow-v13') {
            Write-Output "DealHunter Java API ready: http://127.0.0.1:8080 (PostgreSQL port $postgresPort)"
            return
        }
    } catch { $lastHealthError = $_.Exception.Message }
    if ($apiProcess.HasExited) { break }
}
throw ('Java API did not become ready. See .local/api-error.log. ' + $lastHealthError)
