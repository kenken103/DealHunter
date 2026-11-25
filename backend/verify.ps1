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
foreach ($collection in @('events','questions','tasks','students','leaders','teamMembers','projects','recruitments','requests','feedbacks','notifications')) {
    Assert-Demo ($data.PSObject.Properties.Name -contains $collection) "Missing dashboard collection: $collection."
    Assert-Demo ($null -ne $data.$collection) "Null dashboard collection: $collection."
}
$eventIds = @($data.events | ForEach-Object { $_.key })
$requestIds = @($data.requests | ForEach-Object { $_.id })
$projectIds = @($data.projects | ForEach-Object { $_.id })
$recruitmentIds = @($data.recruitments | ForEach-Object { $_.id })
$studentIds = @($data.students | ForEach-Object { $_.id })
foreach ($record in @($data.projects) + @($data.events) + @($data.requests) + @($data.recruitments)) {
    Assert-Demo ($record.upperCompany -is [string] -and $record.endCompany -is [string]) 'Project company metadata must be present as strings, including legacy cases.'
    Assert-Demo ($record.upperCompany.Length -le 200 -and $record.endCompany.Length -le 200) 'Company names exceed the input length limit.'
}
Assert-Demo (@($data.teamMembers).Count -eq 0) 'Sales received a leader-only team directory.'
foreach ($event in $data.events) {
    Assert-Demo ($event.key -and $event.projectId -and $event.project -and $event.person) 'Event/project/person association is missing.'
    Assert-Demo ([bool]$event.studentId) 'Event participant identity is missing.'
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
    Assert-Demo ($request.id -and $request.projectId -and $request.studentId) 'Request/participant association is invalid.'
    Assert-Demo ($request.status -in @('requested','responded','confirmed')) 'Request status is invalid.'
    Assert-Demo ($request.scheduleMode -in @('candidates','availability')) 'Request schedule mode is invalid.'
    Assert-Demo ($null -ne $request.requestedDates) 'Request date constraints are missing.'
    if ($request.scheduleMode -eq 'availability' -and $request.status -eq 'requested') {
        Assert-Demo (@($request.candidates).Count -eq 0) 'An unanswered availability inquiry already has proposed times.'
    } else {
        Assert-Demo (@($request.candidates).Count -gt 0) 'Request candidates or availability proposals are missing.'
    }
    if ($request.scheduleMode -eq 'candidates') { Assert-Demo (@($request.requestedDates).Count -eq 0) 'Fixed candidates must not have separate date constraints.' }
    foreach ($slot in $request.candidates) {
        Assert-Demo ($slot.start -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$') 'Candidate start is invalid.'
        Assert-Demo ($null -eq $slot.end -or ($slot.end -gt $slot.start -and $slot.end.Substring(0,10) -eq $slot.start.Substring(0,10))) 'Candidate end must be absent or later on the same date.'
        if ($request.scheduleMode -eq 'availability') {
            Assert-Demo ($null -eq $slot.end -and $request.availableSlotIds -contains $slot.id) 'Availability proposals must have only a start and be available.'
            Assert-Demo (@($request.requestedDates).Count -eq 0 -or $request.requestedDates -contains $slot.start.Substring(0,10)) 'An availability proposal is outside the requested dates.'
        }
    }
    $candidateIds = @($request.candidates | ForEach-Object { $_.id })
    foreach ($slotId in $request.availableSlotIds) { Assert-Demo ($candidateIds -contains $slotId) 'Available slot belongs to another request.' }
    if ($request.status -eq 'confirmed') { Assert-Demo (@($request.availableSlotIds) -contains $request.confirmedSlotId) 'Confirmed slot was not answered as available.' }
}
foreach ($recruitment in $data.recruitments) {
    Assert-Demo ($recruitment.id -and $projectIds -contains $recruitment.projectId) 'Recruitment/project association is missing.'
    Assert-Demo ($recruitment.status -in @('pending','assigned') -and $recruitment.leaderId) 'Recruitment status or assigned leader is invalid.'
    Assert-Demo ($recruitment.scheduleMode -in @('candidates','availability') -and $null -ne $recruitment.requestedDates) 'Recruitment scheduling metadata is missing.'
    if ($recruitment.status -eq 'pending') {
        Assert-Demo (@($recruitment.studentIds).Count -eq 0) 'A pending recruitment already has interviewers.'
        Assert-Demo (@($data.requests | Where-Object projectId -eq $recruitment.projectId).Count -eq 0) 'Personal requests exist before interviewer selection.'
    } else {
        Assert-Demo (@($recruitment.studentIds).Count -gt 0) 'An assigned recruitment has no interviewers.'
        foreach ($studentId in $recruitment.studentIds) {
            Assert-Demo ([bool]$studentId) 'Recruitment participant identity is missing.'
            Assert-Demo (@($data.requests | Where-Object { $_.projectId -eq $recruitment.projectId -and $_.studentId -eq $studentId }).Count -eq 1) 'Selected interviewer does not have exactly one personal request.'
        }
    }
    if ($recruitment.scheduleMode -eq 'availability') {
        Assert-Demo (@($recruitment.candidates).Count -eq 0) 'Availability recruitment must not have fixed candidate templates.'
    } else {
        Assert-Demo (@($recruitment.candidates).Count -gt 0 -and @($recruitment.requestedDates).Count -eq 0) 'Fixed recruitment candidate templates are missing or mixed with date constraints.'
    }
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
    if ($task.action -eq 'assign') {
        Assert-Demo ($recruitmentIds -contains $task.recruitmentId) 'Task recruitment association is missing.'
        Assert-Demo ($task.owner -eq 'リーダー' -and -not $task.requestId -and -not $task.eventId) 'Assignment task must target the leader recruitment.'
    }
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
Assert-Demo (@($studentData.recruitments).Count -eq 0 -and @($studentData.teamMembers).Count -eq 0) 'Student received recruitment or team information.'
foreach ($leader in $data.leaders) {
    $leaderHeaders = @{ 'X-DealHunter-Key' = $key; 'X-DealHunter-User' = $leader.id }
    $leaderData = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/dashboard' -Headers $leaderHeaders -TimeoutSec 5
    Assert-Demo (@($leaderData.leaders).Count -eq 0) 'Leader received the sales-only leader directory.'
    Assert-Demo (@($leaderData.projects | Where-Object leaderId -ne $leader.id).Count -eq 0) 'Leader received another leader project.'
    Assert-Demo (@($leaderData.recruitments | Where-Object leaderId -ne $leader.id).Count -eq 0) 'Leader received another leader recruitment.'
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
    $cluster = & $pgCommand.Source -X -w -h 127.0.0.1 -p 15432 -U dealhunter -d dealhunter -v ON_ERROR_STOP=1 -tAc "SELECT current_setting('data_directory') || '|' || current_setting('port') || '|' || current_setting('TimeZone')"
    Assert-Demo ($LASTEXITCODE -eq 0) 'Database query failed.'
    $parts = $cluster.Split('|')
    $expectedData = (Resolve-Path -LiteralPath (Join-Path $root '.local/postgres')).Path
    Assert-Demo ([IO.Path]::GetFullPath($parts[0]) -eq $expectedData) 'Unexpected PostgreSQL cluster: isolation failed.'
    Assert-Demo ($parts[1] -eq '15432' -and $parts[2] -eq 'Asia/Tokyo') 'Unexpected database port or timezone.'
    $checkSql = @'
SELECT jsonb_build_object(
 'users',(SELECT count(*) FROM app_users),
 'sales',(SELECT count(*) FROM app_users WHERE role='sales'),
 'students',(SELECT count(*) FROM app_users WHERE role='student'),
 'leaders',(SELECT count(*) FROM app_users WHERE role='leader'),
 'admins',(SELECT count(*) FROM app_users WHERE role='admin'),
 'leader_members',(SELECT count(*) FROM leader_members),
 'projects',(SELECT count(*) FROM projects),
 'recruitments',(SELECT count(*) FROM recruitments),
 'recruitment_candidate_slots',(SELECT count(*) FROM recruitment_candidate_slots),
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
 (SELECT count(*) FROM leader_members m JOIN app_users l ON l.id=m.leader_id JOIN app_users u ON u.id=m.student_id WHERE m.active AND (l.role<>'leader' OR u.role<>'student')) +
 (SELECT count(*) FROM recruitments a JOIN projects p ON p.id=a.project_id WHERE p.leader_id IS NULL
  OR (a.status='pending' AND EXISTS(SELECT 1 FROM interview_requests r WHERE r.recruitment_id=a.id))
  OR (a.status='assigned' AND NOT EXISTS(SELECT 1 FROM interview_requests r WHERE r.recruitment_id=a.id))) +
 (SELECT count(*) FROM interview_requests r JOIN recruitments a ON a.id=r.recruitment_id WHERE r.project_id<>a.project_id OR r.schedule_mode<>a.schedule_mode OR r.requested_dates<>a.requested_dates) +
 (SELECT count(*) FROM scheduled_events e JOIN interview_requests r ON r.id=e.request_id WHERE r.student_id<>e.student_id OR r.project_id<>e.project_id) +
 (SELECT count(*) FROM interview_feedback f JOIN scheduled_events e ON e.id=f.event_id WHERE f.student_id<>e.student_id OR e.kind<>'meet') +
 (SELECT count(*) FROM interview_questions q JOIN scheduled_events e ON e.id=q.event_id WHERE q.project_id<>e.project_id) +
 (SELECT count(*) FROM interview_questions q JOIN interview_feedback f ON f.id=q.feedback_id WHERE q.event_id IS DISTINCT FROM f.event_id) +
 (SELECT count(*) FROM interview_requests r LEFT JOIN candidate_slots s ON s.id=r.confirmed_slot_id WHERE r.status='confirmed' AND (s.id IS NULL OR s.request_id<>r.id OR NOT s.available)) +
 (SELECT count(*) FROM task_acknowledgements a JOIN projects p ON p.id=a.project_id WHERE p.sales_id<>a.user_id)
)::text;
'@
    $summaryJson = & $pgCommand.Source -X -w -h 127.0.0.1 -p 15432 -U dealhunter -d dealhunter -v ON_ERROR_STOP=1 -tAc $checkSql
    Assert-Demo ($LASTEXITCODE -eq 0) 'Database relation checks failed.'
    $summary = $summaryJson | ConvertFrom-Json
    Assert-Demo ($summary.invalid_relations -eq 0) 'Database contains invalid role/ownership/question/confirmed-slot relations.'
    Assert-Demo ($summary.students -eq @($data.students).Count) 'Sales student directory differs from database.'
    Assert-Demo ($summary.leaders -eq @($data.leaders).Count) 'Sales leader directory differs from current database roles.'
    Assert-Demo ($summary.admins -ge 1) 'At least one administrator must remain registered.'
    if ($Empty) {
        foreach ($table in @('projects','recruitments','recruitment_candidate_slots','scheduled_events','interview_questions','pending_tasks','interview_requests','candidate_slots','request_attachments','project_attachments','interview_feedback','notification_previews','task_acknowledgements')) {
            Assert-Demo ($summary.$table -eq 0) "Expected empty case table: $table."
        }
        Assert-Demo ($summary.users -ge 13 -and $summary.sales -ge 1 -and $summary.students -ge 1 -and $summary.leaders -ge 1 -and $summary.admins -ge 1) 'Registered accounts and an administrator must be retained.'
        foreach ($collection in @('events','questions','tasks','recruitments','requests','feedbacks','notifications')) {
            Assert-Demo (@($data.$collection).Count -eq 0 -and @($studentData.$collection).Count -eq 0) "Expected empty dashboard collection: $collection."
        }
    }
} finally {
    $env:PGPASSWORD = $oldPassword
}
if ($Empty) {
    Write-Output 'PASS: all case tables empty; accounts and administrator preserved; empty dashboards; API key, leader scope, relations and PostgreSQL isolation.'
} else {
    Write-Output 'PASS: API key validation, role-scoped access, existing-record relations, JST, PostgreSQL isolation and method/path validation. Empty data is supported.'
}
