import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Use scripts/verify-end-companies.ps1 -EntryConflicts to get an isolated, seeded database.
const testRoot = process.env.DEALHUNTER_END_TEST_ROOT;
assert(testRoot, "A fresh isolated test stack is required");
const fixture = JSON.parse((await readFile(path.join(testRoot, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
const { apiPort, postgresPort } = fixture;
assert(apiPort > 0 && apiPort !== 8080 && postgresPort > 0 && ![15432, 55432].includes(postgresPort));
assert.equal((await readFile(path.join(testRoot, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const key = (await readFile(path.join(testRoot, "api-key"), "utf8")).trim();
const sales = "sales-aoki", secondSales = "entry-test-sales", student = "student-takahashi";
const secondStudent = "student-yamamoto", leader = "leader-sato";

function sql(text, variables = {}) {
  const parameters = Object.entries(variables).flatMap(([name, value]) => ["-v", name + "=" + value]);
  const result = spawnSync(path.join(fixture.postgresBin, "psql.exe"), [
    "-X", "-qAt", "-h", "127.0.0.1", "-p", String(postgresPort), "-d", "dealhunter_end_companies_test",
    "-U", "dealhunter", "-v", "ON_ERROR_STOP=1", ...parameters, "-f", "-",
  ], { input: text, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || "Test SQL failed");
  return result.stdout.trim();
}

async function call(user, route, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": key, "Content-Type": "application/json", ...(user ? { "X-DealHunter-User": user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (expected !== null) assert.equal(response.status, expected, route + ": " + (data.error ?? "unexpected response"));
  return { status: response.status, data };
}

let fixtureMinute = 0;
async function meeting(name, owner = sales, studentId = student, participantName = "同じ参画者表記") {
  const meetingTime = "2032-01-10T13:" + String(fixtureMinute++).padStart(2, "0");
  const { data: created } = await call(owner, "requests", {
    project: name, summary: "隔離DBの架空案件", upperCompany: "検証用上位", endCompany: "検証用エンド",
    participantName, studentIds: [studentId], leaderId: leader,
    assignmentMode: "direct", scheduleMode: "candidates", candidates: [{ start: meetingTime }],
  });
  const slotId = sql("SELECT id FROM candidate_slots WHERE request_id=:'id';", { id: created.requestId });
  await call(studentId, `requests/${created.requestId}/respond`, { slotIds: [slotId] });
  const { data: confirmed } = await call(owner, `requests/${created.requestId}/confirm`, { slotId, url: "https://meet.example/test-entry" });
  return { name, owner, studentId, projectId: created.projectId, eventId: confirmed.eventId };
}

const entryRoute = (m, check = false) => `events/${m.eventId}/${check ? "entry-check" : "entry"}`;
async function check(m, when) {
  return (await call(m.owner, entryRoute(m, true), { when })).data.entryWarning;
}
function save(m, when, token, expected = 200) {
  return call(m.owner, entryRoute(m), { result: "passed", when, where: "テスト受付", memo: "テスト案内", entryWarningToken: token }, expected);
}
function snapshot(m) {
  return sql(`SELECT jsonb_build_array(
    (SELECT to_jsonb(e) FROM scheduled_events e WHERE id=:'event'),
    (SELECT count(*) FROM scheduled_events WHERE parent_event_id=:'event'),
    (SELECT count(*) FROM notification_previews WHERE project_id=:'project')
  );`, { event: m.eventId, project: m.projectId });
}
function warningResponse(result) {
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "ENTRY_DAY_CONFLICT");
  assert.equal(typeof result.data.entryWarning.token, "string");
  assert(result.data.entryWarning.token.length > 12);
  return result.data.entryWarning;
}

assert.equal(sql("SELECT count(*) FROM projects;"), "0", "Entry tests require an unused fixture DB");
sql(`INSERT INTO app_users(id,display_name,role) VALUES('entry-test-sales','別担当のテスト営業','sales');`);
const base = await meeting("試験・既存");
const target = await meeting("試験・確認");
const otherUser = await meeting("試験・別人", sales, secondStudent);
const otherProject = await meeting("試験・別営業の案件", secondSales, student, "全く別の参画者表記");
const day = "2032-01-20", first = day + "T00:00", last = day + "T23:59";
assert.equal(await check(base, first), null);
const { data: firstEntry } = await save(base, first);
await call(student, `events/${firstEntry.eventId}/acknowledge`, {revision: 1}, 409);
// Conflict checks must also include a previously confirmed entry. Seed that state independently of the clock.
sql("UPDATE scheduled_events SET engineer_confirmed_at=now() WHERE id=:'id';", {id: firstEntry.eventId});
const before = snapshot(target);
const equalTime = await check(target, first);
assert.deepEqual(equalTime.visibleEntries, [{ project: base.name, when: first }]);
assert.equal(equalTime.hasHiddenEntries, false);
const differentTime = await check(target, last);
assert.deepEqual(differentTime.visibleEntries, equalTime.visibleEntries);
assert.equal(await check(target, "2032-01-19T23:59"), null);
assert.equal(await check(target, "2032-01-21T00:00"), null);
assert.equal(await check(otherUser, first), null, "Identical free-text participant names must not identify a person");
warningResponse(await save(target, last, undefined, 409));
warningResponse(await save(target, last, equalTime.token, 409)); // Different proposed time
warningResponse(await save(target, last, "not-an-acknowledgment", 409));
assert.equal(snapshot(target), before, "Preflight and rejected saves must leave the parent, entry and notices unchanged");
for (const actor of [student, leader, secondSales]) {
  for (const [route, payload] of [[entryRoute(target, true), { when: last }], [entryRoute(target), { result: "passed", when: last, where: "test" }]]) {
    await call(actor, route, payload, 403);
  }
}
await call(null, entryRoute(target, true), { when: last }, 401);
await call(sales, entryRoute(target, true), { when: "2032-01-20T00:00:00Z" }, 400);
console.log("PASS: matching student ID and JST day, including both day boundaries, visible details, role/ownership checks, and no writes before acknowledgment.");

const otherTime = day + "T08:37";
const otherWarning = await check(otherProject, otherTime);
assert.equal(otherWarning.hasHiddenEntries, false);
assert.deepEqual(otherWarning.visibleEntries, [{ project: base.name, when: first }]);
assert.deepEqual(Object.keys(otherWarning).sort(), ["hasHiddenEntries", "token", "visibleEntries"]);
const repeatedWarning = warningResponse(await save(otherProject, otherTime, undefined, 409));
assert.deepEqual(repeatedWarning, otherWarning);
await save(otherProject, otherTime, otherWarning.token);
const changed = warningResponse(await save(target, last, differentTime.token, 409));
assert.equal(changed.hasHiddenEntries, false);
assert.deepEqual(changed.visibleEntries, [...equalTime.visibleEntries, { project: otherProject.name, when: otherTime }]);
assert.notEqual(changed.token, differentTime.token);
assert.equal(snapshot(target), before, "Stale acknowledgment must have no side effects");
await save(target, last, changed.token);
assert.equal(sql("SELECT count(*) FROM scheduled_events WHERE parent_event_id=:'id';", { id: target.eventId }), "1");
console.log("PASS: sales users see names and times for all conflicting entries; a new entry invalidates the previous acknowledgment.");

const sameProject = await meeting("試験・同一案件");
const inactive = await meeting("試験・無効予定");
sql(`INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,schedule_state)
VALUES ('entry-same-project',:'same','student-takahashi','2032-01-24','07:00','entry','','','scheduled'),
('entry-cancelled',:'other','student-takahashi','2032-01-24','11:00','entry','','','cancelled'),
('entry-postponed',:'other','student-takahashi','2032-01-24','11:30','entry','','','postponed');`,
  { same: sameProject.projectId, other: inactive.projectId });
sql(`INSERT INTO project_import_history(project_id,student_id,source_row,status,entry_date,source_data)
     VALUES (:'same','student-takahashi',1,'joined','2032-01-24','{}'),
            (:'other','student-takahashi',2,'joined','2032-01-25','{}');`,
    {same: sameProject.projectId, other: inactive.projectId});
const importProbe = await meeting("試験・取込の照合");
const imported = await check(importProbe, "2032-01-25T10:00");
assert.deepEqual(imported.visibleEntries, [{project: inactive.name, when: "2032-01-25（時刻未登録）"}]);
const duplicate = await check(importProbe, "2032-01-24T10:00");
assert.deepEqual(duplicate.visibleEntries, [{project: sameProject.name, when: "2032-01-24T07:00"}]);
assert.equal(await check(sameProject, "2032-01-24T10:00"), null);
await save(sameProject, "2032-01-24T10:00");
await call(sales, entryRoute(inactive), { result: "rejected" });
assert.equal(sql("SELECT count(*) FROM scheduled_events WHERE parent_event_id=:'id';", { id: inactive.eventId }), "0");
console.log("PASS: same-project, cancelled and postponed entries excluded; rejected interviews still produce no entry.");

async function verifyConcurrentSaves(label, onDay) {
  const left = await meeting("試験・並行A" + label), right = await meeting("試験・並行B" + label);
  const when = onDay + "T10:00";
  assert.deepEqual(await Promise.all([check(left, when), check(right, when)]), [null, null]);
  const results = await Promise.all([save(left, when, undefined, null), save(right, when, undefined, null)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], label + ": exactly one unchecked save should commit");
  const loser = results[0].status === 409 ? left : right;
  const conflict = warningResponse(results.find(r => r.status === 409));
  const count = () => sql("SELECT count(*) FROM scheduled_events WHERE kind='entry' AND event_date=:'day';", { day: onDay });
  assert.equal(count(), "1");
  await save(loser, when, conflict.token);
  assert.equal(count(), "2");
  console.log("PASS: " + label + ": concurrent saves after two clean checks yield 200/409, then a second entry only after acknowledgment.");
}

// Widen the insert window to exercise lock hand-off with both normal and snapshot DB defaults.
sql(`CREATE FUNCTION slow_test_entry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
CREATE TRIGGER slow_test_entry_insert BEFORE INSERT ON scheduled_events FOR EACH ROW WHEN (NEW.kind='entry') EXECUTE FUNCTION slow_test_entry_insert();`);
try {
  await verifyConcurrentSaves("read committed", "2032-01-26");
  sql("ALTER DATABASE dealhunter_end_companies_test SET default_transaction_isolation TO 'repeatable read';");
  assert.equal(sql("SHOW transaction_isolation;"), "repeatable read");
  await verifyConcurrentSaves("repeatable read", "2032-01-27");
} finally {
  sql("ALTER DATABASE dealhunter_end_companies_test RESET default_transaction_isolation;");
  sql("DROP TRIGGER slow_test_entry_insert ON scheduled_events; DROP FUNCTION slow_test_entry_insert();");
}

const attendees = ["entry-qa-engineer-a", "entry-qa-engineer-b"];
sql(`INSERT INTO app_users(id,display_name,role) VALUES
    ('entry-qa-engineer-a','検証用面談者甲','student'),('entry-qa-engineer-b','検証用面談者乙','student');`);
const dashboard = async actor => (await call(actor, "dashboard")).data;
async function verifyMeetingConflicts() {
  const day = sql("SELECT ((now() AT TIME ZONE 'Asia/Tokyo')::date+45)::text;");
  const at = time => day + "T" + time;
  const { data: group } = await call(sales, "requests", {
    project: "試験・複数面談者の同時確定", summary: "隔離テスト", upperCompany: "検証会社", participantName: "テスト参画者",
    studentIds: attendees, leaderId: leader, assignmentMode: "direct", scheduleMode: "candidates",
    candidates: [{ start: at("09:00"), end: at("14:00") }],
  });
  // Confirm the busy engineer second, after the first group member's event and preview have been written.
  const requests = (await dashboard(sales)).requests.filter(r => r.projectId === group.projectId)
    .sort((a, b) => a.id < b.id ? -1 : 1);
  assert.equal(requests.length, 2);
  for (const r of requests) await call(r.studentId, `requests/${r.id}/respond`, { slotIds: [r.candidates[0].id] });
  const busy = requests[1];
  const reserved = await meeting("試験・別担当営業の既存面談", secondSales, busy.studentId);
  await call(secondSales, `events/${reserved.eventId}/notice`, {
    revision: 1, start: at("11:00"), end: at("12:00"), prepStart: at("10:00"), reason: "テスト日時へ変更",
  });
  const individual = `requests/${busy.id}/confirm`;
  for (const times of [
    { start: at("10:00"), end: at("10:15") },                       // Existing briefing vs proposed interview
    { start: at("12:00"), end: at("12:30"), prepStart: at("11:20") }, // Existing interview vs proposed briefing
  ]) {
    const conflict = await call(sales, individual, { slotId: busy.candidates[0].id, ...times }, 409);
    assert(conflict.data.error.includes(reserved.name));
  }
  const requestIds = requests.map(r => r.id);
  const notices = () => sql("SELECT count(*) FROM notification_previews WHERE project_id=:'id';", { id: group.projectId });
  const before = notices();
  const conflict = await call(sales, "requests/group-confirm", { requestIds, start: at("11:30"), end: at("12:30") }, 409);
  assert(conflict.data.error.includes(reserved.name));
  const after = await dashboard(sales);
  assert.equal(after.events.filter(e => e.projectId === group.projectId).length, 0);
  assert.deepEqual(after.requests.filter(r => r.projectId === group.projectId).map(r => r.status), ["responded", "responded"]);
  assert.equal(notices(), before);
  const adjacent = await call(sales, "requests/group-confirm", { requestIds, start: at("12:00"), end: at("12:30") });
  assert.equal(adjacent.data.eventIds.length, 2, "An adjacent interview can start at the previous end time");
  console.log("PASS: cross-project interview and briefing collisions, atomic rollback of group confirmations and previews, adjacent time slots.");
}

async function verifyEntryLifecycle() {
  const person = attendees[0];
  const m = await meeting("試験・入場案内と参画終了の訂正", sales, person);
  // Move only this disposable interview into the past to exercise completed placements through the public workflow.
  sql("UPDATE scheduled_events SET event_date=(now() AT TIME ZONE 'Asia/Tokyo')::date-7 WHERE id=:'id';", { id: m.eventId });
  const [entryDay, endDay] = sql("SELECT d-3, d-1 FROM (SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date AS d) q;").split("|");
  const { data: entry } = await save(m, entryDay + "T09:00");
  const route = `events/${entry.eventId}`;
  const exit = `projects/${m.projectId}/exit`;
  const current = async () => (await dashboard(person)).events.find(e => e.key === entry.eventId);
  await call(person, route + "/notice-read", { revision: 1 });
  await call(sales, route + "/entry-change", {
    revision: 1, scheduleState: "scheduled", when: entryDay + "T10:00", where: "変更後の受付", memo: "変更後の案内", reason: "受付変更",
  });
  const revised = await current();
  assert.equal(revised.noticeRevision, 2);
  assert.equal(revised.noticeReadAt, null);
  assert.equal(revised.engineerConfirmedAt, null);
  assert.deepEqual(revised.changes.map(h => [h.revision, h.meetingPlace, h.start]), [
    [2, "変更後の受付", entryDay + "T10:00"], [1, "テスト受付", entryDay + "T09:00"],
  ]);
  await call(person, route + "/notice-read", { revision: 1 }, 409);
  await call(person, route + "/acknowledge", { revision: 1 }, 409);
  await call(person, route + "/notice-read", { revision: 2 });
  assert.equal((await current()).engineerConfirmedAt, null, "Reading the updated notice must not complete the placement");
  const end = { studentId: person, endedOn: endDay, reason: "試験契約満了" };
  await call(sales, exit, end, 409);
  await call(person, route + "/acknowledge", { revision: 2 });
  assert((await current()).engineerConfirmedAt);
  await call(secondSales, exit, end, 403);
  await call(sales, exit, end);
  const ended = await current();
  assert.deepEqual([ended.endedOn, ended.exitReason], [endDay, end.reason]);
  const correction = { revision: 2, scheduleState: "scheduled", undoCompletion: true, reason: "本人の完了報告を訂正" };
  await call(sales, route + "/entry-change", correction, 409);
  const previous = { studentId: person, previousEnd: endDay, previousReason: end.reason };
  await call(sales, exit, { ...end, ...previous, endedOn: entryDay, reason: "試験・終了日訂正" });
  await call(sales, exit, { ...previous, resume: true }, 409);
  await call(sales, exit, { studentId: person, previousEnd: entryDay, previousReason: "試験・終了日訂正", resume: true });
  await call(sales, route + "/entry-change", correction);
  const reopened = await current();
  assert.deepEqual([reopened.endedOn, reopened.engineerConfirmedAt, reopened.noticeReadAt, reopened.noticeRevision], [null, null, null, 3]);
  assert(reopened.changes[0].reason.includes(correction.reason));
  await call(person, route + "/acknowledge", { revision: 2 }, 409);
  await call(person, route + "/acknowledge", { revision: 3 });
  console.log("PASS: changed entry plan requires current acknowledgment; exit, correction, resumption and entry-completion correction retain the correct history.");
}

await verifyMeetingConflicts();
await verifyEntryLifecycle();

if (process.argv.includes("--browser-fixtures")) {
  const booked = await meeting("画面検証・入場登録済");
  await save(booked, "2032-02-08T09:00");
  const browserCases = [booked];
  for (const name of ["戻って日程変更", "承知して登録", "割込み元", "割込み先"]) browserCases.push(await meeting("画面検証・" + name));
  browserCases.push(await meeting("画面検証・別人同名参画者", sales, secondStudent));
  await writeFile(path.join(testRoot, "entry-browser-fixtures.json"), JSON.stringify(browserCases, null, 2), "utf8");
}
