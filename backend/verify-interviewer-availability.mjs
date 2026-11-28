import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Run only through the disposable PostgreSQL and Java harness.
const root = process.env.DEALHUNTER_END_TEST_ROOT;
assert(root);
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert.equal(manifest.testRoot, root);
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const { apiPort, postgresPort } = manifest;
assert(apiPort > 0 && apiPort !== 8080 && postgresPort > 0 && ![15432, 55432].includes(postgresPort));
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();
const first = "student-takahashi", second = "student-yamamoto", sales = "sales-aoki";
const endpoint = id => "interviewer-availability/" + id;

async function request(actor, route, body, expected = 200) {
  const response = await fetch("http://127.0.0.1:" + apiPort + "/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": key, ...(actor && { "X-DealHunter-User": actor }), "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert([expected].flat().includes(response.status), route + " HTTP " + response.status + " " + JSON.stringify(data));
  return { status: response.status, data };
}

function sql(statement) {
  const result = spawnSync(path.join(manifest.postgresBin, "psql.exe"), ["-XqAt", "-h", "127.0.0.1", "-p", String(postgresPort),
    "-U", "dealhunter", "-d", "dealhunter_end_companies_test", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  { input: statement, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const read = async (actor, student, status) => (await request(actor, endpoint(student), undefined, status)).data;
const change = async (actor, student, body, status) => (await request(actor, endpoint(student), body, status)).data;
const add = (date, start, end) => ({ action: "add", date, start, end });
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
function day(offset) {
  const date = new Date(today + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
const shared = await read(sales, first);
assert.equal(shared.fromDate, today);
assert.equal(shared.throughDate, day(13));
assert.equal(shared.studentId, first);
if (process.argv.includes("--persisted")) {
  assert.deepEqual(shared.slots.map(({ date, start, end }) => [date, start, end]), [[day(1), "09:30", "10:30"]]);
  assert.deepEqual(shared, await read(first, first));
  assert.deepEqual((await read(sales, second)).slots, []);
  if (process.argv.includes("--browser-fixture")) {
    const old = "検証用・旧社名";
    const { data } = await request(sales, "requests", { project: "検証用・参考枠", summary: "架空データ",
      upperCompany: old, endCompany: "検証用・エンド", leaderId: "leader-sato", assignmentMode: "direct",
      studentIds: [first], scheduleMode: "availability", candidates: [] });
    await request(sales, "interviewer-company-restrictions/" + first, { companyRole: "upper", companyName: old, restricted: true });
    await request("admin-initial", "admin/projects/" + data.projectId, { upperCompany: "検証用・新社名", revision: 1 });
  }
  console.log("PASS: persisted availability, cancellation and optional browser fixtures.");
  process.exit(0);
}
assert.deepEqual(shared.slots, []);
assert.deepEqual(await read(first, first), shared);
const slot = add(day(1), "09:00", "10:00");
for (const actor of [second, "leader-sato", "admin-initial", null]) {
  const denied = actor ? 403 : 401;
  await read(actor, first, denied);
  await change(actor, first, slot, denied);
}
await change(sales, first, slot, 403);
for (const invalid of ["no-such-person", "leader-sato", sales]) await read(sales, invalid, 404);
for (const invalid of [add(day(-1), "12:00", "13:00"), add(day(14), "00:00", "00:01"),
  add(day(1), "23:59", "00:00"), add(day(1), "12:00", "12:00"), add(day(1), "23:00", "24:00"),
  add("2030-02-30", "10:00", "11:00"), { ...slot, studentId: second }]) {
  await change(first, first, invalid, 400);
}
const midnight = await change(first, first, add(day(13), "00:00", "00:01"));
await change(first, first, { action: "remove", id: midnight.slots[0].id });
const latest = await change(first, first, add(day(13), "23:58", "23:59"));
await change(first, first, { action: "remove", id: latest.slots[0].id });
const race = await Promise.all([1, 2].map(() => request(first, endpoint(first), slot, [200, 409])));
assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
const { slots: [original] } = await read(first, first);
const secondPerson = await change(second, second, slot);
assert.notEqual(secondPerson.slots[0].id, original.id);
const ownUpdate = { action: "update", id: original.id, date: day(1), start: "09:30", end: "10:30" };
await change(second, second, ownUpdate, 404);
await change(second, second, { action: "remove", id: original.id }, 404);
const updated = await change(first, first, ownUpdate);
assert.deepEqual(updated.slots, [{ id: original.id, date: day(1), start: "09:30", end: "10:30" }]);
const adjacent = await change(first, first, add(day(1), "10:30", "11:00"));
const adjacentId = adjacent.slots[1].id;
// The disposable Lark service reports first always free, second busy 10:00–11:00
// JST, and all other calendars inaccessible. Search returns only IDs and counts.
const searchPath = "available-interviewers";
const interval = (start, end) => ({date: day(1), start, end});
async function search(start, end) {
  return (await request(sales, searchPath, interval(start, end))).data;
}
for (const actor of [first, "leader-sato", "admin-initial", null]) {
  await request(actor, searchPath, interval("09:30", "10:00"), actor ? 403 : 401);
}
for (const invalid of [{}, interval("11:00", "10:00"), interval("10:00", "10:00"),
  {...interval("10:00","11:00"), date:day(14)}, {...interval("10:00","11:00"), date:day(-1)}]) {
  await request(sales, searchPath, invalid, 400);
}
const total = Number(sql("SELECT count(*) FROM app_users WHERE role='student'"));
// Only the disposable fixture directory resolves these two synthetic addresses.
sql(`UPDATE app_users SET email='takahashi@example.test' WHERE id='${first}';
    UPDATE app_users SET email='yamamoto@example.test' WHERE id='${second}';`);
const exact = await search("09:30","10:30");
assert.deepEqual(exact, {matches:[first], counts:{busy:1, unavailable:total-2, booked:0, unknownEnd:0}});
assert.deepEqual((await search("08:00","08:30")).matches.sort(), [first, second].sort(), "Lark-free people match outside manually shared hours");
assert.deepEqual((await search("09:30","10:00")).matches.sort(), [first, second].sort());
assert.deepEqual((await search("11:00","11:30")).matches.sort(), [first, second].sort());
assert.deepEqual((await search("09:30","11:00")).matches, [first]);
assert.deepEqual((await search("10:00","11:01")).matches, [first]);
await change(first, first, {action:"update", id:adjacentId, date:day(1), start:"10:31", end:"11:00"});
assert.deepEqual((await search("09:30","11:00")).matches, [first], "a gap in manual slots does not override Lark availability");
await change(first, first, {action:"update", id:adjacentId, date:day(1), start:"10:30", end:"11:00"});
const project = "lookup-fixture-project", meeting = "lookup-fixture-meeting";
sql(`INSERT INTO projects(id,name,sales_id) VALUES('${project}','lookup fixture','${sales}');
    INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,end_time,kind,route,format)
    VALUES('${meeting}','${project}','${first}','${day(1)}','10:00','10:30','meet','test','test');`);
function snapshot() {
  return sql("SELECT (SELECT count(*) FROM projects),(SELECT count(*) FROM interview_requests),(SELECT count(*) FROM candidate_slots),(SELECT count(*) FROM scheduled_events),(SELECT count(*) FROM notification_previews),(SELECT count(*) FROM interviewer_availability_slots)");
}
const beforeSearch = snapshot();
assert.deepEqual((await search("09:30","10:00")).matches.sort(), [first, second].sort());
assert.deepEqual((await search("10:30","11:00")).matches, [first]);
for (const [start,end] of [["10:00","10:30"],["09:59","10:01"],["10:29","10:31"]]) {
  const result = await search(start,end);
  assert.deepEqual(result.matches, []);
  assert.equal(result.counts.booked, 1);
}
sql(`UPDATE scheduled_events SET end_time=NULL WHERE id='${meeting}'`);
assert.equal((await search("10:00","10:30")).counts.booked, 1);
assert.equal((await search("10:30","11:00")).counts.unknownEnd, 1);
for (const state of ["postponed","cancelled"]) {
  sql(`UPDATE scheduled_events SET schedule_state='${state}' WHERE id='${meeting}'`);
  assert.deepEqual((await search("10:00","11:00")).matches, [first]);
}
assert.equal(snapshot(), beforeSearch);
sql(`DELETE FROM scheduled_events WHERE id='${meeting}'; DELETE FROM projects WHERE id='${project}';`);
await change(second, second, { action: "remove", id: secondPerson.slots[0].id });
assert.deepEqual((await read(sales, second)).slots, []);
assert((await search("11:00","11:30")).matches.includes(second), "a Lark-free engineer needs no manually shared slots");
sql(`UPDATE app_users SET email='engineer.takahashi@dealhunter.example' WHERE id='${first}';
    UPDATE app_users SET email='engineer.yamamoto@dealhunter.example' WHERE id='${second}';`);
console.log("PASS: sales Lark free/busy lookup, inaccessible calendars, independent manual slots, local conflicts/boundaries, uncertain end, permissions and read-only counts.");
await change(first, first, { ...ownUpdate, id: adjacentId }, 409);
await change(first, first, { action: "remove", id: adjacentId });
sql("INSERT INTO interviewer_availability_slots(id,student_id,start_at,end_at) SELECT 'expired-qa','student-takahashi',t,t+interval '1 minute' FROM (SELECT date_trunc('day',now() AT TIME ZONE 'Asia/Tokyo')-interval '2 minutes' AS t) s;");
assert.deepEqual(await read(sales, first), updated);
await change(first, first, { action: "remove", id: "expired-qa" }, 404);
assert.equal(sql("SELECT (SELECT count(*) FROM interview_requests)+(SELECT count(*) FROM candidate_slots)+(SELECT count(*) FROM scheduled_events)+(SELECT count(*) FROM notification_previews);"), "0");
console.log("PASS: self CRUD, separate interviewers, sales read only, role boundaries, dates in JST, concurrency, overlap, adjacent intervals, hidden history and no booking or notification.");
