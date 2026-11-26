param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$PostgresBin = $env:DEALHUNTER_POSTGRES_BIN,
    [int]$PostgresPort = 25439,
    [int]$ApiPort = 18089,
    [switch]$HoldOpen,
    [switch]$EntryConflicts,
    [switch]$InterviewerCompanyRestrictions,
    [switch]$InterviewerAvailability,
    [switch]$SimilarProjects,
    [switch]$SalesSharing,
    [switch]$EngineerStatus,
    [switch]$RequestDrafts,
    [switch]$RequestCancellation,
    [switch]$ProjectDeletion,
    [switch]$Stop,
    [string]$TestRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
$markerValue = 'dealhunter_end_companies_test'

function Assert-TestRoot([string]$Directory) {
    $resolved = [IO.Path]::GetFullPath($Directory)
    $tempRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.local/end-company-tests')).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved)).StartsWith('dealhunter-end-companies-')) {
        throw 'Refusing to operate outside the generated end-company test directory.'
    }
    $marker = Join-Path $resolved '.dealhunter-end-company-test'
    if (-not (Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker).Trim() -ne $markerValue) { throw 'Test directory marker is missing.' }
    return $resolved
}
function Stop-TestJava($Manifest) {
    if (-not $Manifest.javaId) { return }
    $process = Get-Process -Id $Manifest.javaId -ErrorAction SilentlyContinue
    if ($process) {
        if ($process.ProcessName -ne 'java' -or $process.StartTime.ToUniversalTime().Ticks -ne $Manifest.javaStartTicks) { throw 'Java PID was reused; refusing to stop it.' }
        Stop-Process -Id $process.Id
        $process.WaitForExit()
    }
}
function Stop-TestStack($Manifest, [string]$Directory) {
    $null = Assert-TestRoot $Directory
    Stop-TestJava $Manifest
    if ($Manifest.postgresStarted) {
        $pgData = Join-Path $Directory 'postgres'
        $pidFile = Join-Path $pgData 'postmaster.pid'
        if (Test-Path -LiteralPath $pidFile) {
            $serverId = [int](Get-Content -LiteralPath $pidFile -TotalCount 1)
            if ($serverId -ne $Manifest.postgresId) { throw 'PostgreSQL PID changed; refusing to stop an unrecognized server.' }
            $process = Get-Process -Id $serverId -ErrorAction SilentlyContinue
            if ($process -and ($process.ProcessName -ne 'postgres' -or $process.StartTime.ToUniversalTime().Ticks -ne $Manifest.postgresStartTicks)) { throw 'PostgreSQL PID was reused; refusing to stop it.' }
            & (Join-Path $Manifest.postgresBin 'pg_ctl.exe') -D $pgData -w -m fast stop | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated test PostgreSQL.' }
        }
    }
}

if ($Stop) {
    if (-not $TestRoot) { throw '-Stop requires the exact generated -TestRoot path.' }
    $TestRoot = Assert-TestRoot $TestRoot
    $manifest = Get-Content -LiteralPath (Join-Path $TestRoot 'processes.json') -Raw | ConvertFrom-Json
    Stop-TestStack $manifest $TestRoot
    Write-Output "Stopped only the isolated end-company test stack: $TestRoot"
    exit 0
}
if ($TestRoot) { throw 'The test harness always creates a fresh directory; -TestRoot is only for -Stop.' }
if ($PostgresPort -in @(15432, 55432) -or $ApiPort -eq 8080 -or $PostgresPort -eq $ApiPort) { throw 'The isolated harness refuses application ports.' }
foreach ($port in @($PostgresPort, $ApiPort)) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } finally { $listener.Stop() }
}
if (-not $JavaHome) { $JavaHome = Split-Path -Parent (Split-Path -Parent (Get-Command java.exe -ErrorAction Stop).Source) }
if (-not $PostgresBin) { $PostgresBin = Split-Path -Parent (Get-Command psql.exe -ErrorAction Stop).Source }
foreach ($executable in @((Join-Path $JavaHome 'bin/javac.exe'), (Join-Path $PostgresBin 'initdb.exe'), (Join-Path $PostgresBin 'pg_ctl.exe'))) {
    if (-not (Test-Path -LiteralPath $executable)) { throw "Missing required executable: $executable" }
}
$testDirectory = Join-Path $projectRoot '.local/end-company-tests'
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
$TestRoot = Join-Path $testDirectory ('dealhunter-end-companies-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
[IO.File]::WriteAllText((Join-Path $TestRoot '.dealhunter-end-company-test'), $markerValue, [Text.UTF8Encoding]::new($false))
$null = Assert-TestRoot $TestRoot
$backend = Join-Path $TestRoot 'backend'
$classes = Join-Path $TestRoot 'classes'
$pgData = Join-Path $TestRoot 'postgres'
New-Item -ItemType Directory -Path $backend, $classes | Out-Null
foreach ($name in @('schema.sql', 'seed-users.sql', 'dashboard.sql')) { Copy-Item -LiteralPath (Join-Path $projectRoot "backend/$name") -Destination $backend }
$keyPath = Join-Path $TestRoot 'api-key'
[IO.File]::WriteAllText($keyPath, [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'), [Text.UTF8Encoding]::new($false))
$passwordPath = Join-Path $TestRoot 'database.password'
$testPassword = [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($passwordPath, $testPassword, [Text.UTF8Encoding]::new($false))
$manifestPath = Join-Path $TestRoot 'processes.json'
$manifest = @{ testRoot = $TestRoot; postgresBin = $PostgresBin; postgresStarted = $false; javaId = $null; postgresPort = $PostgresPort; apiPort = $ApiPort; apiKeyPath = $keyPath; backendPath = $backend }
function Save-Manifest { $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8 }
function Start-TestJava([switch]$LarkFixture) {
    $classPath = "$classes;$(Join-Path $projectRoot 'backend/lib/*')"
    $mainClass = if ($InterviewerAvailability -or $LarkFixture) { 'LarkAvailabilityHarness' } else { 'DealHunterServer' }
    $process = Start-Process -FilePath (Join-Path $JavaHome 'bin/java.exe') -ArgumentList @('-cp', "`"$classPath`"", $mainClass, "`"$backend`"") -WorkingDirectory $TestRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $TestRoot 'api.log') -RedirectStandardError (Join-Path $TestRoot 'api-error.log') -PassThru
    $manifest.javaId = $process.Id
    $manifest.javaStartTicks = $process.StartTime.ToUniversalTime().Ticks
    Save-Manifest
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/health" -TimeoutSec 1 -DisableKeepAlive
            if ($health.service -eq 'dealhunter' -and $health.status -eq 'ok') { return }
        } catch { }
        if ($process.HasExited) { break }
    }
    throw "Isolated Java API did not become ready. See $TestRoot/api-error.log"
}
$environment = @{
    DEALHUNTER_DATABASE_URL = "jdbc:postgresql://127.0.0.1:$PostgresPort/dealhunter_end_companies_test"
    DEALHUNTER_DATABASE_USER = 'dealhunter'
    DEALHUNTER_DATABASE_PASSWORD = $testPassword
    PGPASSWORD = $testPassword
    DEALHUNTER_API_KEY = [IO.File]::ReadAllText($keyPath)
    DEALHUNTER_API_PORT = [string]$ApiPort
    DEALHUNTER_END_TEST_API = "http://127.0.0.1:$ApiPort"
    DEALHUNTER_END_TEST_PGPORT = [string]$PostgresPort
    DEALHUNTER_END_TEST_ROOT = $TestRoot
    DEALHUNTER_END_TEST_PSQL = Join-Path $PostgresBin 'psql.exe'
    PGCLIENTENCODING = 'UTF8'
}
$oldEnvironment = @{}
$succeeded = $false
try {
    foreach ($entry in $environment.GetEnumerator()) { $oldEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process'); [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    $sources = @(Get-ChildItem -Path (Join-Path $projectRoot 'backend/src/*.java') -File | ForEach-Object { $_.FullName })
    if ($InterviewerAvailability -or $RequestCancellation) { $sources += Join-Path $projectRoot 'backend/test/LarkAvailabilityHarness.java' }
    & (Join-Path $JavaHome 'bin/javac.exe') -encoding UTF-8 --release 21 -cp (Join-Path $projectRoot 'backend/lib/*') -d $classes @sources
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Java compilation failed.' }
    & (Join-Path $PostgresBin 'initdb.exe') -D $pgData --username=dealhunter --encoding=UTF8 --locale=C "--pwfile=$passwordPath" --auth-local=scram-sha-256 --auth-host=scram-sha-256
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the fresh isolated test cluster.' }
    # pg_ctl forks a daemon. On Windows its child must not inherit PowerShell's output pipe.
    $pgLog = Join-Path $TestRoot 'postgres.log'
    $pgParams = @('-D', ('"{0}"' -f $pgData), '-w', '-t', '30', '-l', ('"{0}"' -f $pgLog), '-o', ('"-h 127.0.0.1 -p {0}"' -f $PostgresPort), 'start')
    $pgStart = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList $pgParams -WindowStyle Hidden -RedirectStandardOutput (Join-Path $TestRoot 'pg-start.log') -RedirectStandardError (Join-Path $TestRoot 'pg-start-error.log') -PassThru
    $pgStart.WaitForExit()
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $pgData status *> $null
    if ($LASTEXITCODE -ne 0) { throw "Could not start the isolated test cluster. See $TestRoot/postgres.log" }
    $manifest.postgresStarted = $true
    $manifest.postgresId = [int](Get-Content -LiteralPath (Join-Path $pgData 'postmaster.pid') -TotalCount 1)
    $manifest.postgresStartTicks = (Get-Process -Id $manifest.postgresId).StartTime.ToUniversalTime().Ticks
    Save-Manifest
    & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p $PostgresPort -U dealhunter --encoding=UTF8 dealhunter_end_companies_test
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated test database.' }
    if ($InterviewerAvailability) {
        $verification = Join-Path $projectRoot 'backend/verify-interviewer-availability.mjs'
        Start-TestJava
        & node $verification
        if ($LASTEXITCODE -ne 0) { throw 'Interviewer availability verification failed.' }
        Stop-TestJava $manifest
        Start-TestJava
        $verificationArgs = @($verification, '--persisted')
        if ($HoldOpen) { $verificationArgs += '--browser-fixture' }
        & node @verificationArgs
        if ($LASTEXITCODE -ne 0) { throw 'Interviewer availability restart verification failed.' }
    } elseif ($InterviewerCompanyRestrictions) {
        $verification = Join-Path $projectRoot 'backend/verify-interviewer-company-restrictions.mjs'
        Start-TestJava
        & node $verification
        if ($LASTEXITCODE -ne 0) { throw 'Interviewer company restriction verification failed.' }
        Stop-TestJava $manifest
        Start-TestJava
        & node $verification --persisted
        if ($LASTEXITCODE -ne 0) { throw 'Interviewer company restart verification failed.' }
    } elseif ($RequestDrafts) {
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-request-drafts.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Interview request draft verification failed.' }
    } elseif ($RequestCancellation) {
        $verification = Join-Path $projectRoot 'backend/verify-request-cancellation.mjs'
        Start-TestJava
        & node $verification
        if ($LASTEXITCODE -ne 0) { throw 'Interview request cancellation verification failed.' }
        Stop-TestJava $manifest
        Start-TestJava -LarkFixture
        & node $verification --persisted
        if ($LASTEXITCODE -ne 0) { throw 'Lark cancellation delivery and restart verification failed.' }
    } elseif ($ProjectDeletion) {
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-project-deletion.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Project deletion verification failed.' }
    } elseif ($EngineerStatus) {
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-engineer-status.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Engineer status verification failed.' }
    } elseif ($SalesSharing) {
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-sales-sharing.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Sales sharing verification failed.' }
    } elseif ($SimilarProjects) {
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-similar-projects.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Similar-project verification failed.' }
    } elseif ($EntryConflicts) {
        Start-TestJava
        $entryArgs = @((Join-Path $projectRoot 'backend/verify-entry-conflicts.mjs'))
        if ($HoldOpen) { $entryArgs += '--browser-fixtures' }
        & node @entryArgs
        if ($LASTEXITCODE -ne 0) { throw 'Initial entry date conflict verification failed.' }
    } else {
        & node (Join-Path $projectRoot 'backend/verify-end-companies.mjs') --seed-legacy
        if ($LASTEXITCODE -ne 0) { throw 'Could not seed the legacy schema before upgrade.' }
        Start-TestJava
        $verificationArgs = @((Join-Path $projectRoot 'backend/verify-end-companies.mjs'))
        if ($HoldOpen) { $verificationArgs += '--browser-fixture' }
        & node @verificationArgs
        if ($LASTEXITCODE -ne 0) { throw 'End-company integration verification failed.' }
        Stop-TestJava $manifest
        Start-TestJava
        & node (Join-Path $projectRoot 'backend/verify-end-companies.mjs') --persisted
        if ($LASTEXITCODE -ne 0) { throw 'Actual restart persistence verification failed.' }
    }
    $succeeded = $true
    Write-Output "PASS: isolated verification. Logs and fixtures: $TestRoot"
    if ($HoldOpen) { Write-Output "Held isolated stack for additional checks. Stop with: ./scripts/verify-end-companies.ps1 -Stop -TestRoot '$TestRoot'" }
} finally {
    try { if (-not ($succeeded -and $HoldOpen)) { Stop-TestStack $manifest $TestRoot } }
    finally { foreach ($entry in $oldEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') } }
}
