import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default: test and remove only this run's generated cases, even on failure.
// For an actual restart check: --prepare, restart Java, then --persisted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/availability-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const base = "http://127.0.0.1:8080";
const sales = "sales-aoki", student = "student-takahashi", secondStudent = "student-mori", outsider = "student-yamamoto", leader = "leader-sato";
const prefix = `統合確認・候補日時の照会 ${randomUUID()}`;
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements"];
const snapshotExpression = `jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})`;
let fixtures = [];

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "55432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", timeout: 20_000, windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const snapshot = () => JSON.parse(sql(`SELECT ${snapshotExpression}::text;`));

async function request(user, endpoint, body, expected = 200) {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${endpoint}: HTTP ${response.status} did not return JSON`); }
  // Track unexpected successful creates too, so a failing validation test is cleaned up.
  if (endpoint === "/api/requests" && data.projectId && body?.project?.startsWith(prefix)) {
    assert(/^DH-[0-9a-f-]{36}$/.test(data.projectId), "Unexpected generated project ID");
    if (!fixtures.some(item => item.id === data.projectId)) fixtures.push({ id: data.projectId, name: body.project });
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${endpoint}: expected HTTP ${statuses.join("/")}, got ${response.status}: ${data.error ?? data.message ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
const savedRequest = async (id, user = sales) => {
  const item = (await dashboard(user)).requests.find(value => value.id === id);
  assert(item, `Request ${id} was not persisted or is not visible to ${user}`);
  return item;
};
const respond = (user, id, body, status = 200) => request(user, `/api/requests/${id}/respond`, body, status);
const confirm = (id, slotId, status = 200, user = sales) => request(user, `/api/requests/${id}/confirm`, { slotId, url: "https://meet.example/availability-integration" }, status);
const draft = (label, overrides = {}) => ({ project: `${prefix} ${label}`, summary: "日時未指定の照会と本人による候補回答の確認用です。", studentIds: [student], leaderId: leader, scheduleMode: "availability", candidates: [], ...overrides });
const create = (label, overrides) => request(sales, "/api/requests", draft(label, overrides), [200, 201]);

function cleanup(targets) {
  if (!targets.length) return;
  for (const item of targets) {
    assert(/^DH-[0-9a-f-]{36}$/.test(item.id) && /^統合確認・候補日時の照会 [0-9a-f-]{36} /.test(item.name), "Unexpected fixture identity; refusing cleanup");
  }
  // psql -v arguments cross Windows' legacy command-line code page. Keep
  // non-ASCII fixture names in JSON escapes; PostgreSQL decodes them as UTF-8.
  const fixtureJson = JSON.stringify(targets).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  sql(`BEGIN;
CREATE TEMP TABLE cleanup_targets ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN jsonb_to_recordset(:'fixtures'::jsonb) AS f(id text,name text)
  ON p.id=f.id AND p.name=f.name WHERE p.sales_id='sales-aoki';
SELECT 1/(CASE WHEN count(*)=:'count'::integer THEN 1 ELSE 0 END) FROM cleanup_targets;
DELETE FROM task_acknowledgements WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM notification_previews WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM interview_questions WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM interview_feedback WHERE event_id IN (SELECT id FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_targets));
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_targets) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM candidate_slots WHERE request_id IN (SELECT id FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_targets));
DELETE FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM projects WHERE id IN (SELECT id FROM cleanup_targets);
COMMIT;`, { fixtures: fixtureJson, count: targets.length });
}

function ownRows(data, targets) {
  const ids = new Set(targets.map(item => item.id));
  return {
    requests: data.requests.filter(item => ids.has(item.projectId)),
    events: data.events.filter(item => ids.has(item.projectId)),
    tasks: data.tasks.filter(item => ids.has(item.projectId)),
    notifications: data.notifications.filter(item => item.lines.some(line => line.label === "案件" && targets.some(target => target.name === line.value))),
  };
}

if (process.argv.includes("--persisted") || process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "prepared", "No prepared availability fixture exists");
  fixtures = state.fixtures;
  try {
    if (!process.argv.includes("--cleanup")) {
      assert.deepEqual(ownRows(await dashboard(sales), fixtures), state.expected, "Restart changed stored inquiries, proposals, confirmations, tasks or previews");
      console.log("PASS: actual Java restart preserved availability/date constraints, proposals and start-only confirmations.");
    }
  } finally {
    cleanup(fixtures);
    assert.deepEqual(snapshot(), state.baseline, "Unrelated database rows changed during the fixture test/restart");
    await writeFile(statePath, JSON.stringify({ ...state, phase: "cleaned" }, null, 2) + "\n", "utf8");
  }
  process.exit(0);
}

const baseline = snapshot();
let keep = false;
try {
  // Reject invalid creates atomically, including mode/date mismatches.
  for (const [label, overrides] of [
    ["unknown-mode", { scheduleMode: "invalid" }],
    ["duplicate-dates", { requestedDates: ["2026-11-20", "2026-11-20"] }],
    ["invalid-date", { requestedDates: ["2026-02-30"] }],
    ["wrong-date-type", { requestedDates: "2026-11-20" }],
    ["mixed-inquiry", { candidates: [{ start: "2026-11-20T10:00" }] }],
    ["empty-fixed", { scheduleMode: "candidates" }],
    ["fixed-date-constraint", { scheduleMode: "candidates", requestedDates: ["2026-11-20"], candidates: [{ start: "2026-11-20T10:00" }] }],
  ]) await request(sales, "/api/requests", draft(label, overrides), 400);
  assert.deepEqual(snapshot(), baseline, "Invalid creates left partial database records");

  // Fully unspecified inquiry, with independent responses from two engineers.
  const inquiry = await create("unrestricted", { studentIds: [student, secondStudent] });
  assert.equal(inquiry.requestIds.length, 2);
  let data = await dashboard(sales);
  const members = data.requests.filter(item => item.projectId === inquiry.projectId);
  const first = members.find(item => item.studentId === student), second = members.find(item => item.studentId === secondStudent);
  assert(first && second);
  for (const item of members) {
    assert.equal(item.scheduleMode, "availability");
    assert.deepEqual(item.requestedDates, []);
    assert.deepEqual(item.candidates, []);
    assert.equal(item.status, "requested");
  }
  assert(!(await dashboard(outsider)).requests.some(item => item.projectId === inquiry.projectId));
  const rejectedBefore = snapshot();
  await respond(sales, first.id, { proposals: [{ start: "2026-11-20T10:00" }] }, 403);
  await respond(leader, first.id, { proposals: [{ start: "2026-11-20T10:00" }] }, 403);
  await respond(outsider, first.id, { proposals: [{ start: "2026-11-20T10:00" }] }, 403);
  await respond(student, second.id, { proposals: [{ start: "2026-11-20T10:00" }] }, 403);
  await confirm(first.id, "nonexistent", 409);
  for (const body of [
    { proposals: [] }, { proposals: [{ start: "not-a-date" }] },
    { proposals: [{ start: "2026-11-20T10:00" }, { start: "2026-11-20T10:00" }] },
    { slotIds: ["nonexistent"] },
    { proposals: [{ start: "2026-11-20T10:00" }], slotIds: ["nonexistent"] },
  ]) await respond(student, first.id, body, 400);
  assert.deepEqual(snapshot(), rejectedBefore, "Denied or invalid replies changed stored data");

  await respond(student, first.id, { proposals: [{ start: "2026-11-20T14:30" }, { start: "2026-11-19T09:00" }] });
  let answered = await savedRequest(first.id);
  assert.equal(answered.status, "responded");
  assert.deepEqual(answered.candidates.map(item => item.start), ["2026-11-19T09:00", "2026-11-20T14:30"]);
  assert(answered.candidates.every(item => item.end === null));
  assert.deepEqual([...answered.availableSlotIds].sort(), answered.candidates.map(item => item.id).sort());
  assert.deepEqual((await savedRequest(second.id)).candidates, [], "Another engineer's request received the first engineer's proposals");
  const staleSlot = answered.candidates[0].id;
  data = await dashboard(sales);
  const task = data.tasks.find(item => item.requestId === first.id && item.action === "schedule");
  assert(task?.unread && Number.isSafeInteger(task.revision));
  await request(sales, `/api/tasks/${task.key}/acknowledge`, { revision: task.revision });

  await respond(secondStudent, second.id, { proposals: [{ start: "2026-11-21T11:00" }] });
  const secondAnswered = await savedRequest(second.id);
  await respond(student, first.id, { proposals: [{ start: "2026-11-23T13:15" }] });
  answered = await savedRequest(first.id, student);
  assert.deepEqual(answered.candidates.map(item => item.start), ["2026-11-23T13:15"]);
  assert(!answered.candidates.some(item => item.id === staleSlot));
  assert.deepEqual(await savedRequest(second.id), secondAnswered, "Re-answering changed another engineer's proposals");
  const revised = (await dashboard(sales)).tasks.find(item => item.key === task.key);
  assert.equal(revised.revision, task.revision + 1);
  assert.equal(revised.unread, true);
  assert.equal(revised.acknowledgedAt, null);
  await confirm(first.id, staleSlot, 400);
  await confirm(first.id, secondAnswered.candidates[0].id, 400);
  await confirm(first.id, answered.candidates[0].id, 403, leader);
  await confirm(first.id, answered.candidates[0].id, 403, student);
  const confirmed = await confirm(first.id, answered.candidates[0].id);
  await respond(student, first.id, { proposals: [{ start: "2026-11-24T10:00" }] }, 409);
  await confirm(first.id, answered.candidates[0].id, 409);
  const meeting = (await dashboard(sales)).events.find(item => item.key === confirmed.eventId);
  assert(meeting && meeting.requestId === first.id && meeting.time === "13:15");
  assert.equal(meeting.end, "", "A missing interview end time was invented");
  assert((await dashboard(student)).events.some(item => item.key === confirmed.eventId));
  assert(!(await dashboard(secondStudent)).events.some(item => item.key === confirmed.eventId));

  // Date-only constraints are shown to the engineer and enforced by the API.
  const constrained = await create("dates-only", { requestedDates: ["2026-11-25", "2026-11-24"] });
  const dates = await savedRequest(constrained.requestId, student);
  assert.deepEqual(dates.requestedDates, ["2026-11-24", "2026-11-25"]);
  assert.deepEqual(dates.candidates, []);
  const beforeOutsideDate = snapshot();
  await respond(student, dates.id, { proposals: [{ start: "2026-11-26T10:00" }] }, 400);
  assert.deepEqual(snapshot(), beforeOutsideDate, "An out-of-date proposal partially changed the inquiry");
  await respond(student, dates.id, { proposals: [{ start: "2026-11-24T15:00" }, { start: "2026-11-25T16:30" }] });
  const datedReply = await savedRequest(dates.id);
  assert.deepEqual(datedReply.candidates.map(item => item.start), ["2026-11-24T15:00", "2026-11-25T16:30"]);
  assert(datedReply.candidates.every(item => item.end === null));

  // Start-only ordinary candidates use the existing selection/confirmation flow.
  const fixed = await create("start-only", { scheduleMode: "candidates", candidates: [{ start: "2026-11-27T18:00" }] });
  const fixedRequest = await savedRequest(fixed.requestId);
  assert.equal(fixedRequest.scheduleMode, "candidates");
  assert.equal(fixedRequest.candidates[0].end, null);
  await respond(student, fixedRequest.id, { proposals: [{ start: "2026-11-28T18:00" }] }, 400);
  await respond(student, fixedRequest.id, { slotIds: [fixedRequest.candidates[0].id] });
  const fixedConfirmation = await confirm(fixedRequest.id, fixedRequest.candidates[0].id);
  assert.equal((await dashboard(sales)).events.find(item => item.key === fixedConfirmation.eventId).end, "");

  // Previously supported requests retain an explicit end time and default mode.
  const legacyBody = draft("legacy", { studentId: student, candidates: [{ start: "2026-11-28T10:00", end: "2026-11-28T10:45" }] });
  delete legacyBody.studentIds;
  delete legacyBody.scheduleMode;
  const legacy = await request(sales, "/api/requests", legacyBody, [200, 201]);
  const legacyRequest = await savedRequest(legacy.requestId);
  assert.equal(legacyRequest.scheduleMode, "candidates");
  assert.equal(legacyRequest.candidates[0].end, "2026-11-28T10:45");
  await respond(student, legacyRequest.id, { slotIds: [legacyRequest.candidates[0].id] });
  const legacyConfirmation = await confirm(legacyRequest.id, legacyRequest.candidates[0].id);
  assert.equal((await dashboard(sales)).events.find(item => item.key === legacyConfirmation.eventId).end, "10:45");

  // Confirm the API's state is stored as actual nullable SQL values.
  const stored = JSON.parse(sql(`SELECT jsonb_build_object('mode',r.schedule_mode,'dates',r.requested_dates,'end',e.end_time,'start',to_char(e.start_time,'HH24:MI'),'candidateEnd',s.end_at)::text
FROM interview_requests r JOIN scheduled_events e ON e.request_id=r.id JOIN candidate_slots s ON s.id=r.confirmed_slot_id WHERE r.id=:'request_id';`, { request_id: first.id }));
  assert.deepEqual(stored, { mode: "availability", dates: [], end: null, start: "13:15", candidateEnd: null });
  if (process.argv.includes("--prepare")) {
    await writeFile(statePath, JSON.stringify({ phase: "prepared", fixtures, baseline, expected: ownRows(await dashboard(sales), fixtures) }, null, 2) + "\n", "utf8");
    keep = true;
    console.log("PASS: availability integration checks passed; exact generated cases retained for restart verification with --persisted (or --cleanup).");
  } else {
    console.log("PASS: unrestricted/date-only inquiries, independent engineer proposals, re-answer revisions/stale-slot rejection, start-only confirmations, legacy end-time compatibility, ownership and validation.");
  }
} finally {
  if (!keep) {
    cleanup(fixtures);
    assert.deepEqual(snapshot(), baseline, "Unrelated database rows changed during availability verification");
    console.log("PASS: removed only this run's generated cases; all pre-existing database rows were preserved.");
  }
}
