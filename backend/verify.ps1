param([switch]$Empty)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$root = Split-Path -Parent $PSScriptRoot
function Assert-Demo($condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Assert-Status([string]$uri, [hashtable]$requestHeaders, [int]$expected, [string]$method = 'GET') {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers $requestHeaders -Method $method -TimeoutSec 5 | Out-Null
    } catch {
        Assert-Demo ($_.Exception.Response.StatusCode.value__ -eq $expected) "Expected HTTP$expected for $uri."
        return
    }
    throw "Expected HTTP$expected for $uri, but the request succeeded."
}

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 5 -DisableKeepAlive
Assert-Demo ($health.status -eq 'ok' -and $health.database -eq 'postgresql') 'PostgreSQL health failed.'
$key = [IO.File]::ReadAllText((Join-Path $root '.local/api-key')).Trim()
$headers = @{ 'X-DealHunter-Key' = $key; 'X-DealHunter-User' = 'sales-aoki' }
$data = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/dashboard' -Headers $headers -TimeoutSec 5
foreach ($collection in @('events','questions','tasks','students','leaders','projects','requests','feedbacks','notifications')) {
    Assert-Demo ($data.PSObject.Properties.Name -contains $collection) "Missing dashboard collection: $collection."
    Assert-Demo ($null -ne $data.$collection) "Null dashboard collection: $collection."
}
$eventIds = @($data.events | ForEach-Object { $_.key })
$requestIds = @($data.requests | ForEach-Object { $_.id })
$projectIds = @($data.events | ForEach-Object { $_.projectId }) + @($data.requests | ForEach-Object { $_.projectId })
$studentIds = @($data.students | ForEach-Object { $_.id })
foreach ($event in $data.events) {
    Assert-Demo ($event.key -and $event.projectId -and $event.project -and $event.person) 'Event/project/person association is missing.'
    Assert-Demo ($studentIds -contains $event.studentId) 'An event references a non-student account.'
    Assert-Demo ($event.type -in @('meet','entry') -and $event.entry -eq ($event.type -eq 'entry')) 'Event type and first-entry marker disagree.'
    Assert-Demo ($event.time -match '^([01][0-9]|2[0-3]):[0-5][0-9]$') 'Event time is invalid.'
    Assert-Demo ([long]$event.stamp % 86400000 -eq 0) 'Event date stamp is not a normalized UTC day.'
    Assert-Demo ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$event.stamp).UtcDateTime.Day -eq [int]$event.date) 'Event date stamp and day disagree.'
    if ($event.requestId) { Assert-Demo ($requestIds -contains $event.requestId) 'Event request association is missing.' }
    if ($event.entry) { Assert-Demo ([bool]$event.meetingPlace) 'First-entry meeting place is missing.' }
}
foreach ($question in $data.questions) {
    Assert-Demo ($question.key -and $question.title -and ($projectIds -contains $question.project)) 'Question/project association is invalid.'
    if ($question.eventId) { Assert-Demo ($eventIds -contains $question.eventId) 'Question/interview association is invalid.' }
}
foreach ($request in $data.requests) {
    Assert-Demo ($request.id -and $request.projectId -and ($studentIds -contains $request.studentId)) 'Request/student association is invalid.'
    Assert-Demo ($request.status -in @('requested','responded','confirmed')) 'Request status is invalid.'
    Assert-Demo (@($request.candidates).Count -gt 0) 'Request candidates are missing.'
    $candidateIds = @($request.candidates | ForEach-Object { $_.id })
    foreach ($slotId in $request.availableSlotIds) { Assert-Demo ($candidateIds -contains $slotId) 'Available slot belongs to another request.' }
    if ($request.status -eq 'confirmed') { Assert-Demo (@($request.availableSlotIds) -contains $request.confirmedSlotId) 'Confirmed slot was not answered as available.' }
}
foreach ($feedback in $data.feedbacks) {
    $event = $data.events | Where-Object key -eq $feedback.eventId
    Assert-Demo ($event -and $event.type -eq 'meet' -and $event.projectId -eq $feedback.projectId -and $event.studentId -eq $feedback.studentId) 'Feedback/interview/student association is invalid.'
}
foreach ($task in $data.tasks) {
    Assert-Demo ($task.projectId -and ($projectIds -contains $task.projectId)) 'Task project association is missing.'
    Assert-Demo ([long]$task.revision -gt 0 -and $task.unread -is [bool]) 'Task acknowledgement metadata is invalid.'
    Assert-Demo ($task.unread -eq ($null -eq $task.acknowledgedAt)) 'Task unread status and acknowledgement time disagree.'
    if ($task.eventId) { Assert-Demo ($eventIds -contains $task.eventId) 'Task event association is missing.' }
    if ($task.requestId) { Assert-Demo ($requestIds -contains $task.requestId) 'Task request association is missing.' }
}

Assert-Status 'http://127.0.0.1:8080/api/dashboard' @{ 'X-DealHunter-User' = 'sales-aoki' } 401
Assert-Status 'http://127.0.0.1:8080/api/dashboard' @{ 'X-DealHunter-Key' = 'invalid-key'; 'X-DealHunter-User' = 'sales-aoki' } 401
Assert-Status 'http://127.0.0.1:8080/api/dashboard' @{ 'X-DealHunter-Key' = $key; 'X-DealHunter-User' = 'unknown-user' } 401
Assert-Status 'http://127.0.0.1:8080/api/dashboard' $headers 405 'POST'
Assert-Status 'http://127.0.0.1:8080/api/dashboard/unknown' $headers 404
$studentHeaders = @{ 'X-DealHunter-Key' = $key; 'X-DealHunter-User' = 'student-takahashi'; 'X-DealHunter-Role' = 'sales' }
$studentData = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/dashboard' -Headers $studentHeaders -TimeoutSec 5
foreach ($collection in @('events','requests','feedbacks')) {
    Assert-Demo (@($studentData.$collection | Where-Object studentId -ne 'student-takahashi').Count -eq 0) "Student received another student's $collection."
}
Assert-Demo (@($studentData.notifications | Where-Object userId -ne 'student-takahashi').Count -eq 0) 'Student received another user notification.'
Assert-Demo (@($studentData.students).Count -eq 1 -and $studentData.students[0].id -eq 'student-takahashi') 'Student lookup is not scoped.'
Assert-Demo (@($studentData.leaders).Count -eq 0) 'Student received the sales-only leader directory.'
foreach ($leader in $data.leaders) {
    $leaderHeaders = @{ 'X-DealHunter-Key' = $key; 'X-DealHunter-User' = $leader.id }
    $leaderData = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/dashboard' -Headers $leaderHeaders -TimeoutSec 5
    Assert-Demo (@($leaderData.leaders).Count -eq 0) 'Leader received the sales-only leader directory.'
    Assert-Demo (@($leaderData.projects | Where-Object leaderId -ne $leader.id).Count -eq 0) 'Leader received another leader project.'
    foreach ($collection in @('events','requests')) {
        Assert-Demo (@($leaderData.$collection | Where-Object leaderId -ne $leader.id).Count -eq 0) "Leader received another leader's $collection."
    }
    $memberIds = @($leaderData.events | ForEach-Object { $_.studentId }) + @($leaderData.requests | ForEach-Object { $_.studentId })
    Assert-Demo (@($leaderData.students | Where-Object { $memberIds -notcontains $_.id }).Count -eq 0) 'Leader received an unrelated student directory entry.'
    Assert-Status 'http://127.0.0.1:8080/api/requests' $leaderHeaders 403 'POST'
}

$pgCommand = Get-Command psql.exe -ErrorAction Stop
$oldPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = [IO.File]::ReadAllText((Join-Path $root '.local/database.password')).Trim()
    $cluster = & $pgCommand.Source -X -w -h 127.0.0.1 -p 55432 -U dealhunter -d dealhunter -v ON_ERROR_STOP=1 -tAc "SELECT current_setting('data_directory') || '|' || current_setting('port') || '|' || current_setting('TimeZone')"
    Assert-Demo ($LASTEXITCODE -eq 0) 'Database query failed.'
    $parts = $cluster.Split('|')
    $expectedData = (Resolve-Path -LiteralPath (Join-Path $root '.local/postgres')).Path
    Assert-Demo ([IO.Path]::GetFullPath($parts[0]) -eq $expectedData) 'Unexpected PostgreSQL cluster: isolation failed.'
    Assert-Demo ($parts[1] -eq '55432' -and $parts[2] -eq 'Asia/Tokyo') 'Unexpected database port or timezone.'
    $checkSql = @'
SELECT jsonb_build_object(
 'users',(SELECT count(*) FROM app_users),
 'sales',(SELECT count(*) FROM app_users WHERE role='sales'),
 'students',(SELECT count(*) FROM app_users WHERE role='student'),
 'leaders',(SELECT count(*) FROM app_users WHERE role='leader'),
 'projects',(SELECT count(*) FROM projects),
 'scheduled_events',(SELECT count(*) FROM scheduled_events),
 'interview_questions',(SELECT count(*) FROM interview_questions),
 'pending_tasks',(SELECT count(*) FROM pending_tasks),
 'interview_requests',(SELECT count(*) FROM interview_requests),
 'candidate_slots',(SELECT count(*) FROM candidate_slots),
 'request_attachments',(SELECT count(*) FROM request_attachments),
 'project_attachments',(SELECT count(*) FROM project_attachments),
 'interview_feedback',(SELECT count(*) FROM interview_feedback),
 'notification_previews',(SELECT count(*) FROM notification_previews),
 'task_acknowledgements',(SELECT count(*) FROM task_acknowledgements),
 'invalid_relations',
 (SELECT count(*) FROM scheduled_events e JOIN app_users u ON u.id=e.student_id WHERE u.role<>'student') +
 (SELECT count(*) FROM projects p JOIN app_users u ON u.id=p.sales_id WHERE u.role<>'sales') +
 (SELECT count(*) FROM projects p JOIN app_users u ON u.id=p.leader_id WHERE u.role<>'leader') +
 (SELECT count(*) FROM interview_requests r JOIN app_users u ON u.id=r.student_id WHERE u.role<>'student') +
 (SELECT count(*) FROM scheduled_events e JOIN interview_requests r ON r.id=e.request_id WHERE r.student_id<>e.student_id OR r.project_id<>e.project_id) +
 (SELECT count(*) FROM interview_feedback f JOIN scheduled_events e ON e.id=f.event_id WHERE f.student_id<>e.student_id OR e.kind<>'meet') +
 (SELECT count(*) FROM interview_questions q JOIN scheduled_events e ON e.id=q.event_id WHERE q.project_id<>e.project_id) +
 (SELECT count(*) FROM interview_questions q JOIN interview_feedback f ON f.id=q.feedback_id WHERE q.event_id IS DISTINCT FROM f.event_id) +
 (SELECT count(*) FROM interview_requests r LEFT JOIN candidate_slots s ON s.id=r.confirmed_slot_id WHERE r.status='confirmed' AND (s.id IS NULL OR s.request_id<>r.id OR NOT s.available)) +
 (SELECT count(*) FROM task_acknowledgements a JOIN projects p ON p.id=a.project_id JOIN app_users u ON u.id=a.user_id WHERE u.role<>'sales' OR p.sales_id<>a.user_id)
)::text;
'@
    $summaryJson = & $pgCommand.Source -X -w -h 127.0.0.1 -p 55432 -U dealhunter -d dealhunter -v ON_ERROR_STOP=1 -tAc $checkSql
    Assert-Demo ($LASTEXITCODE -eq 0) 'Database relation checks failed.'
    $summary = $summaryJson | ConvertFrom-Json
    Assert-Demo ($summary.invalid_relations -eq 0) 'Database contains invalid role/ownership/question/confirmed-slot relations.'
    Assert-Demo ($summary.students -eq @($data.students).Count) 'Sales student directory differs from database.'
    Assert-Demo ($summary.leaders -eq 2 -and @($data.leaders).Count -eq 2) 'Expected the two registered readonly leaders in the sales directory.'
    if ($Empty) {
        foreach ($table in @('projects','scheduled_events','interview_questions','pending_tasks','interview_requests','candidate_slots','request_attachments','project_attachments','interview_feedback','notification_previews','task_acknowledgements')) {
            Assert-Demo ($summary.$table -eq 0) "Expected empty case table: $table."
        }
        Assert-Demo ($summary.users -eq 12 -and $summary.sales -eq 1 -and $summary.students -eq 9 -and $summary.leaders -eq 2) 'Expected accounts: one sales, nine students and two readonly leaders.'
        foreach ($collection in @('events','questions','tasks','requests','feedbacks','notifications')) {
            Assert-Demo (@($data.$collection).Count -eq 0 -and @($studentData.$collection).Count -eq 0) "Expected empty dashboard collection: $collection."
        }
    }
} finally {
    $env:PGPASSWORD = $oldPassword
}
if ($Empty) {
    Write-Output 'PASS: all eleven case tables empty; twelve users preserved; empty dashboards; API key, readonly leader scope, relations and PostgreSQL isolation.'
} else {
    Write-Output 'PASS: API key validation, role-scoped access, existing-record relations, JST, PostgreSQL isolation and method/path validation. Empty data is supported.'
}
