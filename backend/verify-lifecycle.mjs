import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const statePath = path.join(root, ".local/lifecycle-test-state.json");
const base = "http://127.0.0.1:8080";
const sales = "sales-aoki";
const student = "student-takahashi";
const otherStudent = "student-yamamoto";

async function request(user, endpoint, body, expected = 200, extraHeaders = {}) {
  const headers = { "X-DealHunter-User": user, "X-DealHunter-Key": apiKey, ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${endpoint}: expected JSON, received HTTP ${response.status}`); }
  const acceptable = Array.isArray(expected) ? expected : [expected];
  assert(acceptable.includes(response.status), `${endpoint}: expected HTTP ${acceptable.join("/")}, got ${response.status}: ${data.error ?? data.message ?? "unexpected response"}`);
  return data;
}

const dashboard = user => request(user, "/api/dashboard");

async function verifyPersisted(state) {
  const data = await dashboard(sales);
  const ownData = await dashboard(student);
  const otherData = await dashboard(otherStudent);
  const persistedRequest = data.requests.find(item => item.id === state.requestId);
  assert(persistedRequest, "Created request was not persisted");
  assert.equal(persistedRequest.confirmedSlotId, state.slotId);
  const meeting = data.events.find(item => item.key === state.eventId);
  assert(meeting, "Confirmed interview was not persisted");
  assert.equal(meeting.url, state.url);
  assert.equal(meeting.person, "高橋 蓮");
  assert.equal(meeting.studentId, student);
  assert.equal(meeting.result, state.mode === "rejected" ? "rejected" : "passed");
  if (state.mode === "rejected") {
    assert(!data.events.some(item => item.entry && item.project === state.project), "Rejected interview unexpectedly created a first-entry event");
  } else {
    const firstEntry = data.events.find(item => item.key === state.entryId);
    assert(firstEntry?.entry, "First-entry event was not persisted");
    assert.equal(firstEntry.studentId, student);
    assert.equal(firstEntry.time, "09:30");
    assert.equal(firstEntry.format, state.place);
    assert.equal(firstEntry.guidance, state.guidance);
    assert(ownData.events.some(item => item.key === state.entryId), "Student cannot see their first entry");
  }
  assert(ownData.events.some(item => item.key === state.eventId), "Student cannot see their confirmed interview");
  assert(!otherData.events.some(item => item.key === state.eventId || item.key === state.entryId), "Unrelated student can see another student's events");
  assert(!otherData.requests.some(item => item.id === state.requestId), "Unrelated student can see another student's request");
  const feedback = data.feedbacks.find(item => item.eventId === state.eventId);
  assert(feedback, "Submitted feedback was not persisted");
  assert.equal(feedback.impression, state.impression);
  assert.deepEqual(feedback.questions, state.questions);
  for (const title of state.questions) {
    assert(data.questions.some(item => item.project === persistedRequest.projectId && item.title === title), "Feedback question is not associated with its project");
    assert(ownData.questions.some(item => item.project === persistedRequest.projectId && item.title === title), "Student cannot see their project's question history");
    assert(!otherData.questions.some(item => item.project === persistedRequest.projectId && item.title === title), "Unrelated student can see private project questions");
  }
  assert(!data.tasks.some(item => item.requestId === state.requestId && item.action === "schedule"), "Confirmed request still has a scheduling task");
  assert(!data.tasks.some(item => item.eventId === state.eventId && (item.action === "feedback" || item.action === "entry")), "Completed feedback/entry still has an unfinished task");
  assert(data.notifications.length > 0, "Notification previews were not persisted");
  for (const id of state.notificationIds ?? []) {
    assert(data.notifications.some(item => item.id === id), "A lifecycle notification preview did not survive persistence");
  }
  return data;
}

if (process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const data = await verifyPersisted(state);
  const savedRequest = data.requests.find(item => item.id === state.requestId);
  assert.equal(savedRequest.project, state.project, "Fixture project name changed; refusing cleanup");
  assert(state.project.startsWith("統合確認・面談から入場 "), "Only this script's generated fixture may be cleaned up");
  const projectId = state.projectId ?? savedRequest.projectId;
  assert.equal(savedRequest.projectId, projectId, "Saved project identity does not match the request");
  assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(projectId), "Seed project IDs cannot be cleaned up");
  const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
  const psql = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const sql = `
BEGIN;
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN interview_requests r ON r.project_id=p.id
WHERE p.id=:'fixture_project' AND p.name=convert_from(decode(:'fixture_name_hex','hex'),'UTF8') AND left(p.name,4)='統合確認'
  AND p.sales_id='sales-aoki' AND r.id=:'fixture_request' AND r.student_id='student-takahashi';
-- A missing or mismatched exact target causes division by zero and rolls back.
SELECT 1/count(*)::integer AS verified_exact_fixture FROM cleanup_target;
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
COMMIT;
`;
  // psql's Windows argv conversion can use the active codepage; pass the
  // Japanese name as ASCII hex and decode it explicitly as UTF-8 in SQL.
  const nameHex = Buffer.from(state.project, "utf8").toString("hex");
  const result = spawnSync(psql, ["-X", "-h", "127.0.0.1", "-p", "55432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1", "-v", `fixture_project=${projectId}`, "-v", `fixture_name_hex=${nameHex}`, "-v", `fixture_request=${state.requestId}`, "-f", "-"], {
    cwd: root,
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" },
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Fixture cleanup failed and transaction was rolled back: ${result.error?.message ?? result.stderr}`);
  const after = await dashboard(sales);
  assert(!after.requests.some(item => item.id === state.requestId), "Fixture request remained after cleanup");
  assert(!after.events.some(item => item.key === state.eventId || item.key === state.entryId), "Fixture events remained after cleanup");
  assert(!after.questions.some(item => item.project === projectId), "Fixture questions remained after cleanup");
  await writeFile(statePath, JSON.stringify({ ...state, projectId, cleanedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
  console.log(`PASS: cleaned only the exact generated fixture ${state.project}; seed projects and all user rows untouched.`);
  process.exit(0);
}

if (process.argv.includes("--persisted")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await verifyPersisted(state);
  console.log(`PASS: persisted request, interview, feedback with ${state.questions.length} questions, first entry, ownership and completed tasks (${state.project}).`);
  process.exit(0);
}

if (process.argv.includes("--rejected")) {
  const project = `統合確認・面談から入場 不合格分岐 ${Date.now().toString(36)}`;
  const created = await request(sales, "/api/requests", {
    project,
    summary: "不合格後も面談所感と質問を提出でき、初回入場は作成されないことを確認します。",
    studentId: student,
    candidates: [{ start: "2026-11-12T10:00", end: "2026-11-12T10:45" }],
  }, [200, 201]);
  const saved = (await dashboard(sales)).requests.find(item => item.id === created.requestId);
  assert(saved, "Rejected-branch request creation failed");
  const slotId = saved.candidates[0].id;
  await request(student, `/api/requests/${created.requestId}/respond`, { slotIds: [slotId] });
  const url = "https://meet.example/rejected-feedback-test";
  const confirmed = await request(sales, `/api/requests/${created.requestId}/confirm`, { slotId, url });
  await request(sales, `/api/events/${confirmed.eventId}/entry`, { result: "rejected" });
  const questions = ["不合格の場合も面談で聞かれた質問をどう記録しますか？"];
  const impression = "今回は不合格でしたが、質問を記録して次の面談準備に活用します。";
  await request(student, `/api/events/${confirmed.eventId}/feedback`, {
    duties: "Java API開発", process: "詳細設計・実装", remote: "週2日", impression, questions,
  });
  const state = { mode: "rejected", project, projectId: saved.projectId, requestId: created.requestId, eventId: confirmed.eventId, slotId, url, questions, impression };
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  await verifyPersisted(state);
  console.log("PASS: rejected interview still accepts and persists student feedback/questions, keeps result rejected, creates no first-entry event and leaves no unfinished task.");
  console.log(`Fixture retained: ${project}. Run --cleanup to remove only this generated fixture.`);
  process.exit(0);
}

await request(sales, "/api/dashboard", undefined, 401, { "X-DealHunter-Key": "" });
await request("unknown-local-user", "/api/dashboard", undefined, 401);
const before = await dashboard(sales);
assert(before.students.some(item => item.id === student), "Selectable registered students missing");

const candidates = [
  { start: "2026-11-12T13:00", end: "2026-11-12T14:00" },
  { start: "2026-11-13T15:00", end: "2026-11-13T16:00" },
];
const project = `統合確認・面談から入場 ${Date.now().toString(36)}`;
const payload = { project, summary: "営業依頼・受講者回答・日時確定・所感・初回入場を実DBで確認します。", studentId: student, candidates };
await request(student, "/api/requests", payload, 403, { "X-DealHunter-Role": "sales" });
await request(sales, "/api/requests", { ...payload, project: "" }, 400);
const created = await request(sales, "/api/requests", payload, [200, 201]);
assert(created.requestId, "Request creation did not return requestId");
assert(created.preview?.title, "Request notification preview missing");

let data = await dashboard(sales);
let savedRequest = data.requests.find(item => item.id === created.requestId);
assert(savedRequest, "Created request did not appear in dashboard");
assert.equal(savedRequest.project, project);
assert.equal(savedRequest.studentId, student);
assert.equal(savedRequest.candidates.length, 2);
const [slot, unselectedSlot] = savedRequest.candidates;
assert(slot.id && unselectedSlot.id, "Candidate slots need stable IDs");
assert(slot.start.startsWith(candidates[0].start), "Candidate start changed its JST local value");
assert((await dashboard(student)).requests.some(item => item.id === created.requestId), "Target student cannot see the new request");

await request(otherStudent, `/api/requests/${created.requestId}/respond`, { slotIds: [slot.id] }, 403);
await request(sales, `/api/requests/${created.requestId}/respond`, { slotIds: [slot.id] }, 403);
await request(student, `/api/requests/${created.requestId}/respond`, { slotIds: ["unknown-slot"] }, 400);
await request(student, `/api/requests/${created.requestId}/respond`, { slotIds: [slot.id] });
data = await dashboard(sales);
savedRequest = data.requests.find(item => item.id === created.requestId);
assert.deepEqual(savedRequest.availableSlotIds, [slot.id], "Student response did not persist the exact available slots");
assert(data.tasks.some(item => item.requestId === created.requestId && item.action === "schedule"), "Student response did not create the sales scheduling task");

const url = "https://meet.example/lifecycle-confirmed";
await request(student, `/api/requests/${created.requestId}/confirm`, { slotId: slot.id, url }, 403);
await request(sales, `/api/requests/${created.requestId}/confirm`, { slotId: unselectedSlot.id, url }, 400);
const confirmed = await request(sales, `/api/requests/${created.requestId}/confirm`, { slotId: slot.id, url });
assert(confirmed.eventId, "Interview confirmation did not return eventId");
assert(confirmed.preview?.title, "Calendar preview is missing from interview confirmation");
await request(sales, `/api/requests/${created.requestId}/confirm`, { slotId: slot.id, url }, 409);
await request(student, `/api/requests/${created.requestId}/respond`, { slotIds: [slot.id] }, 409);

const questions = Array.from({ length: 37 }, (_, index) => `統合確認${index + 1}：Java APIとSQLの整合性をどう確認しますか？`);
const impression = "業務内容と担当範囲を理解できました。次の案内を確認します。";
const feedback = { duties: "請求管理APIの開発", process: "基本設計から結合テスト", remote: "週3日リモート", impression, questions };
await request(otherStudent, `/api/events/${confirmed.eventId}/feedback`, feedback, 403);
await request(sales, `/api/events/${confirmed.eventId}/feedback`, feedback, 403);
await request(student, `/api/events/${confirmed.eventId}/feedback`, feedback);
data = await dashboard(sales);
assert(data.feedbacks.some(item => item.eventId === confirmed.eventId), "Sales cannot review the student's submitted feedback");

const place = "品川オフィス 1階総合受付（統合確認）";
const guidance = "本人確認書類と筆記用具を持参し、受付で青木宛てとお伝えください。";
const entryPayload = { result: "passed", when: "2026-11-16T09:30", where: place, memo: guidance };
await request(student, `/api/events/${confirmed.eventId}/entry`, entryPayload, 403);
await request(sales, `/api/events/${confirmed.eventId}/entry`, { ...entryPayload, where: "" }, 400);
const entryResult = await request(sales, `/api/events/${confirmed.eventId}/entry`, entryPayload);
assert(entryResult.preview?.title, "First-entry calendar preview is missing");
data = await dashboard(sales);
const entry = data.events.find(item => item.entry && item.project === project);
assert(entry, "Passing the interview did not create a first-entry event");
const previousNotificationIds = new Set(before.notifications.map(item => item.id));
const notificationIds = data.notifications.filter(item => !previousNotificationIds.has(item.id)).map(item => item.id);
assert(notificationIds.length >= 3, "Request, interview and first-entry notification/calendar previews were not stored");

const state = { project, projectId: savedRequest.projectId, requestId: created.requestId, eventId: confirmed.eventId, entryId: entry.key, slotId: slot.id, url, questions, impression, place, guidance, notificationIds };
await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
await verifyPersisted(state);
console.log(`PASS: create → respond → confirm → feedback (${questions.length} questions) → first entry, persisted state, notification/calendar previews, task completion, role tampering, ownership, invalid input and duplicate guards.`);
console.log(`Fixture retained: ${project}. After restarting the backend, run node backend/verify-lifecycle.mjs --persisted.`);
