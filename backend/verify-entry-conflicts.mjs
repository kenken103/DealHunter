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

const meetingTime = "2032-01-10T13:00";
async function meeting(name, owner = sales, studentId = student, participantName = "同じ参画者表記") {
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
await call(student, `events/${firstEntry.eventId}/acknowledge`, {});
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

if (process.argv.includes("--browser-fixtures")) {
  const booked = await meeting("画面検証・入場登録済");
  await save(booked, "2032-02-08T09:00");
  const browserCases = [booked];
  for (const name of ["戻って日程変更", "承知して登録", "割込み元", "割込み先"]) browserCases.push(await meeting("画面検証・" + name));
  browserCases.push(await meeting("画面検証・別人同名参画者", sales, secondStudent));
  await writeFile(path.join(testRoot, "entry-browser-fixtures.json"), JSON.stringify(browserCases, null, 2), "utf8");
}
