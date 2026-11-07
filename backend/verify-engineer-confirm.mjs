import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/engineer-confirm-test-state.json");
const baselinePath = path.join(root, ".local/engineer-confirm-test-before.json");
const preparedPath = path.join(root, ".local/engineer-confirm-test-prepared.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const sales = "sales-aoki", student = "student-takahashi", otherStudent = "student-mori";
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements"];
const saveJson = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + "\n", "utf8");
const readJson = async filename => JSON.parse(await readFile(filename, "utf8"));

async function request(user, endpoint, body, expected = 200) {
  const response = await fetch("http://127.0.0.1:8080" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${endpoint}: HTTP ${response.status} did not return JSON`); }
  assert((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${endpoint}: expected HTTP ${expected}, got ${response.status}: ${data.error ?? data.message ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
const acknowledge = (user, id, expected = 200) => request(user, `/api/events/${id}/acknowledge`, {}, expected);

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "55432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function canonical(snapshot, ignoredEventIds = []) {
  const copy = structuredClone(snapshot);
  for (const row of copy.scheduled_events ?? []) if (ignoredEventIds.includes(row.id)) row.engineer_confirmed_at = null;
  for (const table of tables) copy[table].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return copy;
}
function snapshot() {
  const entries = tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",");
  return canonical(JSON.parse(sql(`SELECT jsonb_build_object(${entries})::text;`)));
}
function event(data, id) {
  const value = data.events.find(item => item.key === id);
  assert(value, `Event ${id} disappeared from dashboard`);
  assert(Object.hasOwn(value, "engineerConfirmedAt"), "All event records must expose engineerConfirmedAt");
  assert(value.engineerConfirmedAt === null || typeof value.engineerConfirmedAt === "string");
  return value;
}
function checkEventsPreserved(before, after, changedId) {
  const normalize = data => data.events.map(item => ({ ...item, ...(item.key === changedId ? { engineerConfirmedAt: null } : {}) })).sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(normalize(after), normalize(before), "Acknowledgement filtered events or changed their business data");
}

async function createCase(state, label) {
  const project = `${state.prefix} ${label} ${state.suffix}`;
  const created = await request(sales, "/api/requests", { project, summary: `受講者の確認済みを案件ごとに独立して保存する検証 ${label}。`, studentId: student, candidates: [{ start: "2026-11-12T13:00", end: "2026-11-12T13:45" }] }, [200, 201]);
  const saved = (await dashboard(sales)).requests.find(item => item.id === created.requestId);
  assert(saved);
  const fixture = { name: project, project, projectId: saved.projectId, requestId: created.requestId, slotId: saved.candidates[0].id };
  state.fixtures.push(fixture);
  if (!state.uiOnly) await saveJson(statePath, state);
  await request(student, `/api/requests/${fixture.requestId}/respond`, { slotIds: [fixture.slotId] });
  const confirmed = await request(sales, `/api/requests/${fixture.requestId}/confirm`, { slotId: fixture.slotId, url: `https://meet.example/engineer-confirm-${label.toLowerCase()}` });
  fixture.meetingId = confirmed.eventId;
  if (!state.uiOnly) await saveJson(statePath, state);
  return fixture;
}
async function feedback(fixture) {
  await request(student, `/api/events/${fixture.meetingId}/feedback`, { duties: "Java API開発", process: "設計・実装", remote: "週2日", impression: "業務内容と面談結果を確認するための検証記録です。", questions: ["面談結果の確認と初回入場の確認をどう分けますか？"] });
}
async function pass(fixture) {
  const result = await request(sales, `/api/events/${fixture.meetingId}/entry`, { result: "passed", when: "2026-11-16T09:30", where: `${fixture.project} 1階受付`, memo: "受付で営業担当者へご連絡ください。" });
  fixture.entryId = result.eventId;
}

async function verifyPrepared(state) {
  assert.equal(state.phase, "prepared", "Expected an acknowledged active fixture from --prepare");
  const [a, b] = state.fixtures;
  const own = await dashboard(student), all = await dashboard(sales);
  for (const data of [own, all]) {
    assert.equal(event(data, a.meetingId).engineerConfirmedAt, state.acknowledgedAt);
    assert.equal(event(data, a.meetingId).result, "passed");
    assert.equal(event(data, a.entryId).engineerConfirmedAt, null, "Meeting acknowledgement must not acknowledge its initial entry");
    assert.equal(event(data, a.entryId).parentEventId, a.meetingId);
    assert.equal(event(data, b.meetingId).engineerConfirmedAt, null, "Another case was acknowledged unexpectedly");
    assert.equal(event(data, b.meetingId).result, "rejected");
  }
  assert.deepEqual(snapshot(), canonical(await readJson(preparedPath)), "Backend restart changed saved records, unrelated cases or users");
}

if (process.argv.includes("--reopen-ui-meeting")) {
  const uiPath=path.join(root,".local/engineer-confirm-ui-fixture.json");
  const state=await readJson(uiPath);
  const requestedId=process.argv[process.argv.indexOf("--event-id")+1];
  assert(state.uiOnly && state.prefix==="画面確認・受講者確認済み" && !state.cleanedAt,"Unexpected UI fixture state");
  const fixture=state.fixtures.find(item=>item.meetingId===requestedId);
  assert(fixture && /^E-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(requestedId),"Explicit event ID must identify a generated UI meeting");
  const before=snapshot(), beforeApi=await dashboard(student);
  const entryAt=event(beforeApi,fixture.entryId).engineerConfirmedAt;
  assert(event(beforeApi,fixture.meetingId).engineerConfirmedAt && entryAt,"Both requested meeting and its entry must currently be confirmed");
  sql(`BEGIN;
WITH target AS (
 SELECT m.id FROM scheduled_events m JOIN projects p ON p.id=m.project_id
 JOIN interview_requests r ON r.id=m.request_id AND r.project_id=p.id
 JOIN scheduled_events en ON en.parent_event_id=m.id AND en.project_id=p.id
 WHERE m.id=:'meeting_id' AND p.id=:'project_id' AND p.name=convert_from(decode(:'name_hex','hex'),'UTF8')
 AND p.sales_id='sales-aoki' AND r.id=:'request_id' AND r.student_id='student-takahashi'
 AND m.student_id='student-takahashi' AND en.student_id='student-takahashi'
 AND m.kind='meet' AND m.result='passed' AND en.kind='entry' AND en.id=:'entry_id'
 AND m.engineer_confirmed_at IS NOT NULL AND en.engineer_confirmed_at IS NOT NULL
 FOR UPDATE OF m,en
), changed AS (
 UPDATE scheduled_events m SET engineer_confirmed_at=NULL FROM target t WHERE m.id=t.id RETURNING m.id
)
SELECT 1/(CASE WHEN count(*)=1 THEN 1 ELSE 0 END) FROM changed;
COMMIT;`,{meeting_id:fixture.meetingId,entry_id:fixture.entryId,project_id:fixture.projectId,
    request_id:fixture.requestId,name_hex:Buffer.from(fixture.project,"utf8").toString("hex")});
  const after=await dashboard(student);
  assert.equal(event(after,fixture.meetingId).engineerConfirmedAt,null);
  assert.equal(event(after,fixture.entryId).engineerConfirmedAt,entryAt,"Entry acknowledgement must remain confirmed");
  assert.deepEqual(canonical(snapshot(),[fixture.meetingId]),canonical(before,[fixture.meetingId]),"A different field, event, case or user changed");
  await saveJson(uiPath,{...state,reopenedMeetingId:fixture.meetingId,reopenedAt:new Date().toISOString()});
  console.log("PASS: only the requested generated meeting was reopened; its entry remains confirmed, and every other stored field/case/user is unchanged.");
  process.exit(0);
}

if (process.argv.includes("--cleanup-ui")) {
  const uiPath=path.join(root,".local/engineer-confirm-ui-fixture.json");
  const state=await readJson(uiPath);
  assert(state.uiOnly && state.prefix==="画面確認・受講者確認済み" && !state.cleanedAt,"Unexpected or already cleaned UI fixtures");
  assert.equal(state.fixtures.length,2,"Expected exactly the two generated UI cases");
  const projectIds=state.fixtures.map(item=>item.projectId);
  assert.equal(new Set(projectIds).size,2,"UI project IDs must be distinct");
  // Capture the current protected state only after acquiring the transaction's
  // locks. Legitimate user activity since older test snapshots must be preserved.
  const protectedPredicates={app_users:"true",projects:"t.id NOT IN(SELECT id FROM cleanup_target)",
    scheduled_events:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    interview_questions:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    pending_tasks:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    interview_requests:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    notification_previews:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    task_acknowledgements:"t.project_id NOT IN(SELECT id FROM cleanup_target)",
    candidate_slots:"t.request_id NOT IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_target))",
    interview_feedback:"t.event_id NOT IN(SELECT id FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_target))"};
  const protectedSql="SELECT jsonb_build_object("+Object.entries(protectedPredicates).map(([table,predicate])=>
    `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${table} t WHERE ${predicate}),'[]'::jsonb)`
  ).join(",")+") AS document";
  const variables={};
  const matches=state.fixtures.map((fixture,index)=>{
    assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(fixture.projectId) && fixture.project.startsWith(`${state.prefix} `),"Unexpected generated UI case");
    variables[`project_${index}`]=fixture.projectId;
    variables[`name_${index}`]=Buffer.from(fixture.project,"utf8").toString("hex");
    variables[`request_${index}`]=fixture.requestId;
    variables[`meeting_${index}`]=fixture.meetingId;
    variables[`entry_${index}`]=fixture.entryId;
    return `(p.id=:'project_${index}' AND p.name=convert_from(decode(:'name_${index}','hex'),'UTF8')
      AND r.id=:'request_${index}' AND m.id=:'meeting_${index}' AND en.id=:'entry_${index}')`;
  });
  sql(`BEGIN;
LOCK TABLE ${tables.join(",")} IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN interview_requests r ON r.project_id=p.id
JOIN scheduled_events m ON m.project_id=p.id AND m.request_id=r.id AND m.kind='meet'
JOIN scheduled_events en ON en.project_id=p.id AND en.parent_event_id=m.id AND en.kind='entry'
WHERE p.sales_id='sales-aoki' AND r.student_id='student-takahashi'
 AND m.student_id='student-takahashi' AND en.student_id='student-takahashi' AND (${matches.join(" OR ")});
SELECT 1/(CASE WHEN count(*)=2 THEN 1 ELSE 0 END) FROM cleanup_target;
CREATE TEMP VIEW protected_rows AS ${protectedSql};
CREATE TEMP TABLE protected_before ON COMMIT DROP AS SELECT document FROM protected_rows;
DELETE FROM task_acknowledgements WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM notification_previews WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM interview_questions WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM interview_feedback WHERE event_id IN (SELECT id FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target));
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM candidate_slots WHERE request_id IN (SELECT id FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_target));
DELETE FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM projects WHERE id IN (SELECT id FROM cleanup_target);
SELECT 1/(CASE WHEN b.document=v.document THEN 1 ELSE 0 END) FROM protected_before b CROSS JOIN protected_rows v;
COMMIT;`,variables);
  const afterApi=await dashboard(sales);
  const remaining=snapshot();
  assert.equal(remaining.app_users.length,12,"All twelve accounts must remain");
  await saveJson(uiPath,{...state,cleanedAt:new Date().toISOString()});
  console.log("PASS: only the two generated UI cases and their dependencies were removed; all non-target records exactly matched the current locked transaction baseline.");
  console.log(JSON.stringify({users:remaining.app_users.length,projects:remaining.projects.length,requests:remaining.interview_requests.length,
    events:remaining.scheduled_events.length,feedbacks:remaining.interview_feedback.length,questions:remaining.interview_questions.length,
    notifications:remaining.notification_previews.length,acknowledgements:remaining.task_acknowledgements.length,
    pendingTasks:afterApi.tasks.length,unreadTasks:afterApi.tasks.filter(item=>item.unread).length,protectedStatePreserved:true}));
  process.exit(0);
}

if (process.argv.includes("--cleanup")) {
  const state = await readJson(statePath);
  assert(!state.cleanedAt && state.prefix === "統合確認・受講者確認済み", "Unexpected or already cleaned test fixture");
  const variables = {};
  const predicates = state.fixtures.map((fixture, index) => {
    assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(fixture.projectId));
    assert(fixture.project.startsWith(`${state.prefix} `));
    variables[`project_${index}`] = fixture.projectId;
    variables[`name_${index}`] = Buffer.from(fixture.project, "utf8").toString("hex");
    variables[`request_${index}`] = fixture.requestId;
    return `(p.id=:'project_${index}' AND p.name=convert_from(decode(:'name_${index}','hex'),'UTF8') AND r.id=:'request_${index}')`;
  });
  assert(predicates.length > 0, "No generated fixture IDs available; refusing cleanup");
  sql(`BEGIN;
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS SELECT p.id FROM projects p JOIN interview_requests r ON r.project_id=p.id
WHERE p.sales_id='sales-aoki' AND r.student_id='student-takahashi' AND (${predicates.join(" OR ")});
SELECT 1/(CASE WHEN count(*)=${state.fixtures.length} THEN 1 ELSE 0 END) FROM cleanup_target;
DELETE FROM task_acknowledgements WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM notification_previews WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM interview_questions WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM interview_feedback WHERE event_id IN (SELECT id FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target));
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM candidate_slots WHERE request_id IN (SELECT id FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_target));
DELETE FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM cleanup_target);
DELETE FROM projects WHERE id IN (SELECT id FROM cleanup_target);
COMMIT;`, variables);
  assert.deepEqual(snapshot(), canonical(await readJson(baselinePath)), "Non-target records changed: users and all nine case tables must exactly match their original complete JSON snapshots");
  await saveJson(statePath, { ...state, cleanedAt: new Date().toISOString() });
  console.log("PASS: deleted only the exact two generated case fixtures; complete JSON snapshots of users and all nine business tables match their original state, including existing TEST case/unread state.");
  process.exit(0);
}

if (process.argv.includes("--persisted")) {
  await verifyPrepared(await readJson(statePath));
  console.log("PASS: acknowledgement timestamp survives real Java restart; initial entry and other case remain unconfirmed; all records/parent links remain visible; complete prepared database snapshot unchanged.");
  process.exit(0);
}

if (process.argv.includes("--continue")) {
  const state = await readJson(statePath);
  await verifyPrepared(state);
  const [a, b] = state.fixtures;
  await acknowledge(otherStudent, a.entryId, 403);
  const beforeEntry = snapshot(), ownBefore = await dashboard(student), salesBefore = await dashboard(sales);
  const entryAck = await acknowledge(student, a.entryId);
  assert(entryAck.engineerConfirmedAt);
  let ownAfter = await dashboard(student), salesAfter = await dashboard(sales);
  assert.equal(event(ownAfter, a.entryId).engineerConfirmedAt, entryAck.engineerConfirmedAt);
  assert.equal(event(ownAfter, a.meetingId).engineerConfirmedAt, state.acknowledgedAt);
  assert.equal(event(ownAfter, b.meetingId).engineerConfirmedAt, null);
  checkEventsPreserved(ownBefore, ownAfter, a.entryId);
  checkEventsPreserved(salesBefore, salesAfter, a.entryId);
  assert.deepEqual(canonical(snapshot(), [a.entryId]), canonical(beforeEntry, [a.entryId]), "Entry acknowledgement changed notifications, sales tasks, another event or user data");
  const beforeRepeat = snapshot();
  assert.equal((await acknowledge(student, a.entryId)).engineerConfirmedAt, entryAck.engineerConfirmedAt);
  assert.deepEqual(snapshot(), beforeRepeat, "Repeated entry acknowledgement changed persisted values");
  const beforeRejected = snapshot();
  const rejectAck = await acknowledge(student, b.meetingId);
  ownAfter = await dashboard(student); salesAfter = await dashboard(sales);
  assert.equal(event(ownAfter, b.meetingId).engineerConfirmedAt, rejectAck.engineerConfirmedAt);
  assert.equal(event(salesAfter, b.meetingId).result, "rejected");
  assert.equal(event(ownAfter, a.entryId).engineerConfirmedAt, entryAck.engineerConfirmedAt);
  assert.equal(event(ownAfter, a.meetingId).engineerConfirmedAt, state.acknowledgedAt);
  assert(!ownAfter.events.some(item => item.projectId === b.projectId && item.entry), "Rejected case unexpectedly created an initial entry");
  assert.deepEqual(canonical(snapshot(), [b.meetingId]), canonical(beforeRejected, [b.meetingId]), "Rejected-result acknowledgement changed other persisted values");
  const rejectedRepeat = snapshot();
  assert.equal((await acknowledge(student, b.meetingId)).engineerConfirmedAt, rejectAck.engineerConfirmedAt);
  assert.deepEqual(snapshot(), rejectedRepeat);
  await saveJson(statePath, { ...state, phase: "completed", entryAcknowledgedAt: entryAck.engineerConfirmedAt, rejectedAcknowledgedAt: rejectAck.engineerConfirmedAt });
  console.log("PASS: entry and rejected-result acknowledgements persist independently, idempotently, without notifications/sales-state changes or server-side record filtering; parent-event data retained.");
  process.exit(0);
}

if (process.argv.includes("--ui-fixture")) {
  const state = { uiOnly: true, prefix: "画面確認・受講者確認済み", suffix: Date.now().toString(36), fixtures: [] };
  for (const label of ["A", "B"]) {
    const fixture = await createCase(state, label);
    await feedback(fixture);
    await pass(fixture);
  }
  const own = await dashboard(student);
  for (const fixture of state.fixtures) {
    assert.equal(event(own, fixture.meetingId).engineerConfirmedAt, null);
    assert.equal(event(own, fixture.entryId).engineerConfirmedAt, null);
    assert.equal(event(own, fixture.entryId).parentEventId, fixture.meetingId);
  }
  await saveJson(path.join(root, ".local/engineer-confirm-ui-fixture.json"), state);
  console.log(JSON.stringify({ message: "Two independent passed meetings and initial entries retained unconfirmed for browser verification", fixtures: state.fixtures }));
  process.exit(0);
}

try {
  const previous = await readJson(statePath);
  assert(previous.cleanedAt, "An unfinished engineer-confirm test fixture exists; finish or clean it before preparing another");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await saveJson(baselinePath, snapshot());
const state = { phase: "starting", prefix: "統合確認・受講者確認済み", suffix: randomUUID(), fixtures: [] };
await saveJson(statePath, state);
const a = await createCase(state, "A");
const pendingSnapshot = snapshot();
await acknowledge(student, a.meetingId, 409);
await acknowledge(sales, a.meetingId, 403);
await acknowledge(otherStudent, a.meetingId, 403);
await acknowledge(student, `E-${randomUUID()}`, 404);
assert.deepEqual(snapshot(), pendingSnapshot, "Rejected acknowledgement attempts changed persisted data");
await feedback(a);
await pass(a);
const b = await createCase(state, "B");
await feedback(b);
await request(sales, `/api/events/${b.meetingId}/entry`, { result: "rejected" });
const before = snapshot(), ownBefore = await dashboard(student), salesBefore = await dashboard(sales);
assert.equal(event(ownBefore, a.meetingId).engineerConfirmedAt, null);
assert.equal(event(ownBefore, a.entryId).engineerConfirmedAt, null);
assert.equal(event(ownBefore, b.meetingId).engineerConfirmedAt, null);
const acknowledged = await acknowledge(student, a.meetingId);
assert(acknowledged.engineerConfirmedAt);
const ownAfter = await dashboard(student), salesAfter = await dashboard(sales);
assert.equal(event(ownAfter, a.meetingId).engineerConfirmedAt, acknowledged.engineerConfirmedAt);
assert.equal(event(ownAfter, a.entryId).engineerConfirmedAt, null);
assert.equal(event(ownAfter, b.meetingId).engineerConfirmedAt, null);
checkEventsPreserved(ownBefore, ownAfter, a.meetingId);
checkEventsPreserved(salesBefore, salesAfter, a.meetingId);
assert.deepEqual(canonical(snapshot(), [a.meetingId]), canonical(before, [a.meetingId]), "Acknowledgement changed notifications, sales tasks, unrelated cases or user data");
const once = snapshot();
assert.equal((await acknowledge(student, a.meetingId)).engineerConfirmedAt, acknowledged.engineerConfirmedAt);
assert.deepEqual(snapshot(), once, "Repeated acknowledgement changed persisted values");
Object.assign(state, { phase: "prepared", acknowledgedAt: acknowledged.engineerConfirmedAt });
await saveJson(statePath, state);
await saveJson(preparedPath, snapshot());
console.log("PASS: pending409, sales403, other-student403, unknown404; passed-result acknowledgement is independent/idempotent, changes only its timestamp, keeps all dashboard records and parent data visible.");
console.log("Prepared fixtures retained. Restart Java, then run --persisted, --continue and --cleanup before creating --ui-fixture.");
