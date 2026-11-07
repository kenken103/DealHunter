import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/task-ack-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const databasePassword = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const sales = "sales-aoki";
const student = "student-takahashi";
const base = "http://127.0.0.1:8080";
const hex = value => Buffer.from(value, "utf8").toString("hex");

async function request(user, endpoint, body, expected = 200, extraHeaders = {}) {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let value;
  try { value = await response.json(); } catch { throw new Error(`${endpoint}: HTTP ${response.status} did not return JSON`); }
  const acceptable = Array.isArray(expected) ? expected : [expected];
  assert(acceptable.includes(response.status), `${endpoint}: expected HTTP ${acceptable.join("/")}, got ${response.status}: ${value.error ?? value.message ?? "unexpected response"}`);
  return value;
}

const dashboard = user => request(user, "/api/dashboard");
const acknowledge = (user, key, revision, expected = 200, headers) => request(user, `/api/tasks/${encodeURIComponent(key)}/acknowledge`, { revision }, expected, headers);
const save = state => writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
const load = async () => JSON.parse(await readFile(statePath, "utf8"));

function sql(statement, variables = {}) {
  const psql = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "55432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(psql, args, { cwd: root, input: statement, encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, PGPASSWORD: databasePassword, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

const taskFor = (data, key) => {
  const task = data.tasks.find(item => item.key === key);
  assert(task, `Expected active task ${key}`);
  assert(Number.isSafeInteger(task.revision) && task.revision > 0, "Task revision must be a positive integer");
  assert.equal(typeof task.unread, "boolean", "Task unread flag is missing");
  assert(task.acknowledgedAt === null || typeof task.acknowledgedAt === "string", "Task acknowledgement timestamp is missing");
  return task;
};

function ownNotifications(data, state) {
  return data.notifications.filter(item => item.projectId === state.projectId || item.lines?.some(line => line.label === "案件" && line.value === state.project)).map(item => item.id).sort();
}

async function verifyAcknowledged(state) {
  assert.equal(state.phase, "prepared", "Run --prepare before checking acknowledgement persistence");
  const data = await dashboard(sales);
  const task = taskFor(data, state.taskKey);
  assert.equal(task.projectId, state.projectId);
  assert.equal(task.revision, state.revision);
  assert.equal(task.unread, false, "Acknowledgement was not persisted");
  assert.equal(task.acknowledgedAt, state.acknowledgedAt, "Acknowledgement timestamp changed across restart/read");
  assert.deepEqual(ownNotifications(data, state), state.notifications, "Acknowledging a task must not create a notification preview");
  return data;
}

async function cleanup(state) {
  assert(!state.cleanedAt, "This test fixture was already cleaned up");
  assert(state.otherSalesId.startsWith("test-sales-taskack-") && state.otherSalesName.startsWith("確認済みAPI検証専用営業 "), "Unexpected test user identity; refusing cleanup");
  const variables = { fixture_user: state.otherSalesId, fixture_user_name_hex: hex(state.otherSalesName) };
  let projectCleanup = "";
  if (state.projectId) {
    assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(state.projectId) && state.project.startsWith("統合確認・対応待ち確認済み "), "Unexpected fixture project; refusing cleanup");
    Object.assign(variables, { fixture_project: state.projectId, fixture_name_hex: hex(state.project), fixture_request: state.requestId });
    projectCleanup = `
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN interview_requests r ON r.project_id=p.id
WHERE p.id=:'fixture_project' AND p.name=convert_from(decode(:'fixture_name_hex','hex'),'UTF8')
  AND p.sales_id='sales-aoki' AND r.id=:'fixture_request' AND r.student_id='student-takahashi';
SELECT 1/count(*)::integer FROM cleanup_target;
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
`;
  }
  sql(`BEGIN;
CREATE TEMP TABLE cleanup_user ON COMMIT DROP AS SELECT id FROM app_users
WHERE id=:'fixture_user' AND display_name=convert_from(decode(:'fixture_user_name_hex','hex'),'UTF8') AND role='sales';
SELECT 1/count(*)::integer FROM cleanup_user;
${projectCleanup}
DELETE FROM app_users WHERE id IN (SELECT id FROM cleanup_user);
COMMIT;`, variables);
  assert.equal(Number(sql("SELECT count(*) FROM app_users;")), 12, "All twelve user records must remain");
  if (state.projectId) {
    const data = await dashboard(sales);
    assert(!data.requests.some(item => item.id === state.requestId), "Fixture request remained after cleanup");
    assert(!data.tasks.some(item => item.projectId === state.projectId), "Fixture task remained after cleanup");
  }
  await save({ ...state, cleanedAt: new Date().toISOString() });
  console.log("PASS: removed only the exact generated task-ack fixture, its acknowledgements and the exact temporary sales user; all twelve users remain.");
}

if (process.argv.includes("--cleanup-ui")) {
  const uiStatePath = path.join(root, ".local/task-ui-fixture.json");
  const state = JSON.parse(await readFile(uiStatePath, "utf8"));
  const expectedProject = process.argv[process.argv.indexOf("--project-id") + 1];
  assert(!state.cleanedAt && expectedProject === state.projectId, "Explicit project ID must match the uncleaned UI fixture");
  assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(state.projectId) && state.project.startsWith("画面確認・対応待ち確認済み "), "Unexpected UI fixture; refusing cleanup");
  const before = await dashboard(sales);
  const protectedTasks = before.tasks.filter(item => item.projectId !== state.projectId);
  assert.equal(protectedTasks.length, 1, "Expected one protected existing pending task before cleanup");
  assert.equal(protectedTasks.filter(item => item.unread).length, 1, "Existing task must remain unread before cleanup");
  const predicates = {
    app_users: "true",
    projects: "s.id<>:'fixture_project'",
    scheduled_events: "s.project_id<>:'fixture_project'",
    interview_questions: "s.project_id<>:'fixture_project'",
    pending_tasks: "s.project_id<>:'fixture_project'",
    interview_requests: "s.project_id<>:'fixture_project'",
    candidate_slots: "s.request_id NOT IN (SELECT id FROM interview_requests WHERE project_id=:'fixture_project')",
    interview_feedback: "s.event_id NOT IN (SELECT id FROM scheduled_events WHERE project_id=:'fixture_project')",
    notification_previews: "s.project_id<>:'fixture_project'",
    task_acknowledgements: "s.project_id<>:'fixture_project'",
  };
  const snapshot = "SELECT jsonb_build_object(" + Object.entries(predicates).map(([table, predicate]) =>
    `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY ${table === "task_acknowledgements" ? "s.user_id,s.task_key" : "s.id"}) FROM ${table} s WHERE ${predicate}),'[]'::jsonb)`
  ).join(",") + ") AS document";
  sql(`BEGIN;
LOCK TABLE ${Object.keys(predicates).join(",")} IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN interview_requests r ON r.project_id=p.id
WHERE p.id=:'fixture_project' AND p.name=convert_from(decode(:'fixture_name_hex','hex'),'UTF8')
  AND p.sales_id='sales-aoki' AND r.id=:'fixture_request' AND r.student_id='student-takahashi';
SELECT 1/count(*)::integer FROM cleanup_target;
CREATE TEMP VIEW protected_rows AS ${snapshot};
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
COMMIT;`, { fixture_project: state.projectId, fixture_name_hex: hex(state.project), fixture_request: state.requestId });
  const after = await dashboard(sales);
  assert.deepEqual(after.tasks, protectedTasks, "Existing pending tasks or acknowledgement states changed");
  assert(!after.requests.some(item => item.id === state.requestId), "UI fixture request remains");
  assert(!after.events.some(item => item.projectId === state.projectId), "UI fixture event remains");
  assert.equal(Number(sql("SELECT count(*) FROM app_users;")), 12, "All accounts must remain");
  const counts = JSON.parse(sql("SELECT jsonb_build_object('projects',(SELECT count(*) FROM projects),'requests',(SELECT count(*) FROM interview_requests),'events',(SELECT count(*) FROM scheduled_events),'feedbacks',(SELECT count(*) FROM interview_feedback),'questions',(SELECT count(*) FROM interview_questions),'notifications',(SELECT count(*) FROM notification_previews),'acknowledgements',(SELECT count(*) FROM task_acknowledgements),'users',(SELECT count(*) FROM app_users))::text;"));
  await writeFile(uiStatePath, JSON.stringify({ ...state, cleanedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
  console.log("PASS: requested UI fixture only removed; every unrelated database row and the existing unread task were preserved.");
  console.log(JSON.stringify({ ...counts, pendingTasks: after.tasks.length, unreadTasks: after.tasks.filter(item => item.unread).length, protectedStatePreserved: true }));
  process.exit(0);
}

if (process.argv.includes("--cleanup")) {
  await cleanup(await load());
  process.exit(0);
}

if (process.argv.includes("--persisted")) {
  const state = await load();
  await verifyAcknowledged(state);
  await acknowledge(sales, state.taskKey, state.revision);
  await verifyAcknowledged(state);
  console.log("PASS: acknowledged revision/timestamp survive backend restart; repeated acknowledgement is idempotent and creates no notification.");
  process.exit(0);
}

if (process.argv.includes("--continue")) {
  const state = await load();
  await verifyAcknowledged(state);
  await request(student, `/api/requests/${state.requestId}/respond`, { slotIds: [state.slotId] });
  let data = await dashboard(sales);
  const revised = taskFor(data, state.taskKey);
  assert.equal(revised.revision, state.revision + 1, "Submitting the same answer must still create a new task revision");
  assert.equal(revised.unread, true, "A new answer must become unread after the previous acknowledgement");
  assert.equal(revised.acknowledgedAt, null, "The previous revision's timestamp must not appear as the new revision's acknowledgement");
  await acknowledge(sales, state.taskKey, state.revision, 409);
  assert.equal(taskFor(await dashboard(sales), state.taskKey).unread, true, "A stale acknowledgement cleared the unread flag");
  await acknowledge(sales, state.taskKey, revised.revision);
  assert.equal(taskFor(await dashboard(sales), state.taskKey).unread, false);
  const confirmed = await request(sales, `/api/requests/${state.requestId}/confirm`, { slotId: state.slotId, url: "https://meet.example/task-ack-integration" });
  await save({ ...state, phase: "confirmed", eventId: confirmed.eventId });
  await acknowledge(sales, state.taskKey, revised.revision, 409);
  data = await dashboard(sales);
  assert(!data.tasks.some(item => item.key === state.taskKey), "Completed scheduling task remained active");
  await request(student, `/api/events/${confirmed.eventId}/feedback`, { duties: "Java API開発", process: "設計・実装", remote: "週2日", impression: "質問と担当範囲を確認しました。", questions: ["確認済みと業務完了をどう区別しますか？"] });
  data = await dashboard(sales);
  const resultKey = `result-${confirmed.eventId}`;
  const resultTask = taskFor(data, resultKey);
  assert.equal(resultTask.projectId, state.projectId);
  assert.equal(resultTask.action, "entry");
  assert.equal(resultTask.title, "面談結果・初回入場を登録");
  assert.equal(resultTask.unread, true, "New result-registration task must be unread");
  assert.equal(resultTask.acknowledgedAt, null);
  assert(!data.tasks.some(item => item.eventId === confirmed.eventId && item.action === "feedback"), "Submitted feedback still appears as pending");
  await acknowledge(state.otherSalesId, resultKey, resultTask.revision, 403);
  await acknowledge(student, resultKey, resultTask.revision, 403);
  const notices = ownNotifications(data, state);
  await acknowledge(sales, resultKey, resultTask.revision);
  const acknowledgedResult = taskFor(await dashboard(sales), resultKey);
  assert.equal(acknowledgedResult.unread, false);
  assert(acknowledgedResult.acknowledgedAt);
  await acknowledge(sales, resultKey, resultTask.revision);
  data = await dashboard(sales);
  assert.equal(taskFor(data, resultKey).acknowledgedAt, acknowledgedResult.acknowledgedAt, "Repeated result acknowledgement changed its timestamp");
  assert.deepEqual(ownNotifications(data, state), notices, "Acknowledging the result created an external-notification preview");
  await request(sales, `/api/events/${confirmed.eventId}/entry`, { result: "passed", when: "2026-11-16T09:00", where: "確認済み検証ビル 1階受付", memo: "受付で担当営業へご連絡ください。" });
  data = await dashboard(sales);
  assert(!data.tasks.some(item => item.key === resultKey), "Result task remained after initial-entry registration");
  await acknowledge(sales, resultKey, resultTask.revision, 409);
  await save({ ...state, phase: "completed", eventId: confirmed.eventId, revisedRevision: revised.revision, resultKey });
  console.log("PASS: same-answer response increments revision and resets unread; stale acknowledgement409; confirmation completes scheduling; submitted feedback creates unread result task; result acknowledgement is idempotent; first entry completes the result task409.");
  console.log("Run --cleanup to remove only this generated fixture and temporary sales user.");
  process.exit(0);
}

if (process.argv.includes("--ui-fixture")) {
  const project = `画面確認・対応待ち確認済み ${Date.now().toString(36)}`;
  const created = await request(sales, "/api/requests", { project, summary: "確認済みボタンと未読表示のブラウザ操作を確認する案件です。", studentId: student, candidates: [{ start: "2026-11-12T16:00", end: "2026-11-12T16:45" }] }, [200, 201]);
  const savedRequest = (await dashboard(sales)).requests.find(item => item.id === created.requestId);
  assert(savedRequest);
  await request(student, `/api/requests/${created.requestId}/respond`, { slotIds: [savedRequest.candidates[0].id] });
  const task = taskFor(await dashboard(sales), `request-${created.requestId}`);
  assert.equal(task.unread, true);
  const uiState = { name: project, project, projectId: savedRequest.projectId, requestId: created.requestId, slotId: savedRequest.candidates[0].id, taskKey: task.key, revision: task.revision };
  await writeFile(path.join(root, ".local/task-ui-fixture.json"), JSON.stringify(uiState, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ message: "Unread task retained for browser verification", ...uiState }));
  process.exit(0);
}

// Default phase leaves an acknowledged, still-active scheduling task for a real
// backend restart. Existing application users and unrelated cases are untouched.
assert.equal(Number(sql("SELECT count(*) FROM app_users;")), 12, "Expected twelve application users before creating the temporary sales fixture");
const suffix = randomUUID();
const state = { phase: "starting", project: `統合確認・対応待ち確認済み ${suffix}`, otherSalesId: `test-sales-taskack-${suffix}`, otherSalesName: `確認済みAPI検証専用営業 ${suffix}` };
sql("INSERT INTO app_users(id,display_name,role) VALUES(:'fixture_user',convert_from(decode(:'fixture_user_name_hex','hex'),'UTF8'),'sales');", { fixture_user: state.otherSalesId, fixture_user_name_hex: hex(state.otherSalesName) });
await save(state);
const created = await request(sales, "/api/requests", { project: state.project, summary: "確認済み・未読再発生・面談結果タスクの統合検証です。", studentId: student, candidates: [{ start: "2026-11-12T13:00", end: "2026-11-12T14:00" }] }, [200, 201]);
let data = await dashboard(sales);
const savedRequest = data.requests.find(item => item.id === created.requestId);
assert(savedRequest);
Object.assign(state, { requestId: created.requestId, projectId: savedRequest.projectId, slotId: savedRequest.candidates[0].id, taskKey: `request-${created.requestId}` });
await save(state);
await request(student, `/api/requests/${state.requestId}/respond`, { slotIds: [state.slotId] });
data = await dashboard(sales);
const task = taskFor(data, state.taskKey);
assert.equal(task.projectId, state.projectId);
assert.equal(task.unread, true, "New student response must be unread");
assert.equal(task.acknowledgedAt, null);
assert.equal(taskFor(await dashboard(sales), state.taskKey).unread, true, "Reading dashboard must not acknowledge the task");
assert(!(await dashboard(state.otherSalesId)).tasks.some(item => item.key === state.taskKey), "Another sales user can see an unowned task");
await acknowledge(student, state.taskKey, task.revision, 403, { "X-DealHunter-Role": "sales" });
await acknowledge(state.otherSalesId, state.taskKey, task.revision, 403);
await acknowledge(sales, `request-R-${randomUUID()}`, 1, 404);
await acknowledge(sales, state.taskKey, task.revision + 1, 409);
const notices = ownNotifications(data, state);
await acknowledge(sales, state.taskKey, task.revision);
const acknowledged = taskFor(await dashboard(sales), state.taskKey);
assert.equal(acknowledged.unread, false);
assert(acknowledged.acknowledgedAt);
await acknowledge(sales, state.taskKey, task.revision);
data = await dashboard(sales);
assert.equal(taskFor(data, state.taskKey).acknowledgedAt, acknowledged.acknowledgedAt, "Repeated acknowledgement changed its original timestamp");
assert.deepEqual(ownNotifications(data, state), notices, "Acknowledgement created a notification preview");
Object.assign(state, { phase: "prepared", revision: task.revision, acknowledgedAt: acknowledged.acknowledgedAt, notifications: notices });
await save(state);
console.log("PASS: new unread task, reads do not acknowledge, explicit acknowledgement/idempotent timestamp/no notification, student403, other-sales ownership403, unknown404 and stale409.");
console.log("Acknowledged active fixture retained. Restart backend, run --persisted, then --continue and --cleanup.");
