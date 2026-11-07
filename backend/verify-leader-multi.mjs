import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/leader-multi-test-state.json");
const baselinePath = path.join(root, ".local/leader-multi-test-before.json");
const preparedPath = path.join(root, ".local/leader-multi-test-prepared.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const sales = "sales-aoki", firstStudent = "student-takahashi", secondStudent = "student-mori";
const firstLeader = "leader-sato", secondLeader = "leader-suzuki";
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements"];
const saveJson = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + "\n", "utf8");
const readJson = async filename => JSON.parse(await readFile(filename, "utf8"));
const hex = value => Buffer.from(value, "utf8").toString("hex");
const snapshotExpression = `jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})`;

async function request(user, endpoint, body, expected = 200) {
  const response = await fetch("http://127.0.0.1:8080" + endpoint, { method: body === undefined ? "GET" : "POST", headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${endpoint}: HTTP ${response.status} did not return JSON`); }
  assert((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${endpoint}: expected HTTP ${expected}, got ${response.status}: ${data.error ?? data.message ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
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
const forProject = (items, id) => items.filter(item => (item.projectId ?? item.project) === id);
const getEvent = (data, id) => {
  const found = data.events.find(item => item.key === id);
  assert(found, `Missing persisted event ${id}`);
  return found;
};

async function createProject(state, label, studentIds, leaderId, legacy = false) {
  const name = `${state.prefix} ${label} ${state.suffix}`;
  const body = { project: name, summary: `${label}の参加者と担当リーダーを独立して確認するための検証案件です。`, candidates: [{ start: "2026-11-12T13:00", end: "2026-11-12T13:45" }, { start: "2026-11-13T15:00", end: "2026-11-13T15:45" }], ...(legacy ? { studentId: studentIds[0] } : { studentIds }), ...(leaderId === undefined ? {} : { leaderId }) };
  const created = await request(sales, "/api/requests", body, [200, 201]);
  const data = await dashboard(sales);
  const first = data.requests.find(item => item.id === created.requestId);
  assert(first, "Created request did not appear in sales dashboard");
  const members = forProject(data.requests, first.projectId);
  assert.deepEqual(members.map(item => item.studentId).sort(), [...studentIds].sort());
  assert.equal(new Set(members.map(item => item.projectId)).size, 1, "A multi-member request must create exactly one project");
  if (!legacy) {
    assert.equal(created.requestIds.length, studentIds.length);
    assert.deepEqual([...created.requestIds].sort(), members.map(item => item.id).sort());
    assert.equal(created.previews.length, studentIds.length);
  }
  if (leaderId) assert(created.leaderPreview?.title, "Assigned leader notification preview is missing");
  const fixture = { name, projectId: first.projectId, leaderId: leaderId ?? null, members: members.map(item => ({ studentId: item.studentId, requestId: item.id, slots: item.candidates })) };
  state.fixtures.push(fixture);
  await saveJson(statePath, state);
  const project = data.projects.find(item => item.id === fixture.projectId);
  assert(project && project.salesId === sales && project.salesName, "Project sales ownership/name is missing");
  assert.equal(project.leaderId, leaderId ?? null);
  for (const member of members) {
    assert.equal(member.leaderId, leaderId ?? null);
    assert.equal(member.leaderName, project.leaderName);
  }
  return fixture;
}

async function verifyViews(state) {
  const [primary, secondary, unassigned] = state.fixtures;
  const data = await dashboard(sales), sato = await dashboard(firstLeader), suzuki = await dashboard(secondLeader);
  const taka = await dashboard(firstStudent), mori = await dashboard(secondStudent);
  assert.equal(data.leaders.length, 2);
  assert(data.leaders.some(item => item.id === firstLeader && item.name === "佐藤 健一"), "Selectable leader identity is missing");
  for (const view of [sato, suzuki, taka, mori]) assert.deepEqual(view.leaders, [], "Only sales may receive the leader selector list");
  for (const fixture of [primary, secondary, unassigned]) {
    const owned = fixture.leaderId === firstLeader;
    assert.equal(sato.projects.some(item => item.id === fixture.projectId), owned);
    assert.equal(suzuki.projects.some(item => item.id === fixture.projectId), fixture.leaderId === secondLeader);
  }
  assert.equal(forProject(sato.requests, primary.projectId).length, 2);
  assert.equal(forProject(suzuki.requests, primary.projectId).length, 0);
  assert.equal(forProject(taka.requests, primary.projectId).length, 1);
  assert.equal(forProject(mori.requests, primary.projectId).length, 1);
  assert(forProject(taka.requests, primary.projectId).every(item => item.studentId === firstStudent));
  assert(forProject(mori.requests, primary.projectId).every(item => item.studentId === secondStudent));
  assert.equal(forProject(taka.requests, secondary.projectId).length, 0);
  for (const member of primary.members) {
    assert.equal(data.requests.find(item => item.id === member.requestId).status, "confirmed");
    const salesEvent = getEvent(data, member.eventId), leaderEvent = getEvent(sato, member.eventId);
    assert.equal(leaderEvent.studentId, member.studentId);
    assert.equal(leaderEvent.leaderId, firstLeader);
    assert.equal(leaderEvent.leaderName, salesEvent.leaderName);
    assert(leaderEvent.engineerConfirmedAt, "Leader lost a completed/engineer-confirmed event");
    assert.equal(leaderEvent.result, member.studentId === firstStudent ? "passed" : "rejected");
    assert(!suzuki.events.some(item => item.key === member.eventId));
  }
  const first = primary.members.find(item => item.studentId === firstStudent), second = primary.members.find(item => item.studentId === secondStudent);
  assert(getEvent(sato, first.entryId).engineerConfirmedAt);
  assert.equal(getEvent(sato, first.entryId).parentEventId, first.eventId);
  assert.equal(forProject(sato.feedbacks, primary.projectId).length, 2);
  assert.equal(forProject(taka.feedbacks, primary.projectId).length, 1);
  assert.equal(forProject(mori.feedbacks, primary.projectId).length, 1);
  assert(forProject(taka.events, primary.projectId).every(item => item.studentId === firstStudent));
  assert(forProject(mori.events, primary.projectId).every(item => item.studentId === secondStudent));
  for (const [viewer, ownMember, otherMember] of [[taka, first, second], [mori, second, first]]) {
    assert.equal(viewer.questions.find(item => item.title === ownMember.question).context, ownMember.secret);
    assert.equal(viewer.questions.find(item => item.title === otherMember.question).context, "", "Another student's feedback impression leaked through question context");
    assert(!JSON.stringify(viewer).includes(otherMember.secret), "Another student's confidential feedback appeared in a student response");
    assert.equal(viewer.questions.find(item => item.key === state.legacyQuestionId).context, state.legacyContext, "Legacy question context should remain available");
  }
  for (const view of [data, sato]) for (const member of primary.members) {
    assert.equal(view.questions.find(item => item.title === member.question).context, member.secret);
    assert(view.feedbacks.some(item => item.eventId === member.eventId && item.impression === member.secret));
  }
  assert(!suzuki.questions.some(item => item.project === primary.projectId));
  if (state.leaderAck) {
    const ownerTask = data.tasks.find(item => item.key === state.leaderAck.key);
    const leaderTask = suzuki.tasks.find(item => item.key === state.leaderAck.key);
    assert(ownerTask && leaderTask, "Assigned leader lost the sales-owned active task");
    assert.equal(ownerTask.unread, false);
    assert.equal(leaderTask.unread, false, "Leader must read the assigned sales owner's acknowledgement state");
    assert.equal(leaderTask.revision, state.leaderAck.revision);
    assert.equal(leaderTask.acknowledgedAt, ownerTask.acknowledgedAt);
    assert.equal(leaderTask.acknowledgedAt, state.leaderAck.acknowledgedAt);
    assert(!sato.tasks.some(item => item.key === state.leaderAck.key));
  }
  return data;
}

async function prepareLeaderAck(state) {
  assert(!state.leaderAck, "Leader acknowledgement fixture was already prepared");
  const member = state.fixtures[1].members[0];
  await request(member.studentId, `/api/requests/${member.requestId}/respond`, { slotIds: [member.slots[0].id] });
  const key = `request-${member.requestId}`;
  const initial = (await dashboard(secondLeader)).tasks.find(item => item.key === key);
  assert(initial && initial.unread && initial.acknowledgedAt === null);
  const rejectedBefore = snapshot();
  await request(secondLeader, `/api/tasks/${key}/acknowledge`, { revision: initial.revision }, 403);
  assert.deepEqual(snapshot(), rejectedBefore, "Leader task acknowledgement attempt changed data");
  await request(sales, `/api/tasks/${key}/acknowledge`, { revision: initial.revision });
  const ownerTask = (await dashboard(sales)).tasks.find(item => item.key === key);
  const leaderTask = (await dashboard(secondLeader)).tasks.find(item => item.key === key);
  assert(ownerTask && leaderTask && ownerTask.acknowledgedAt);
  assert.equal(ownerTask.unread, false);
  assert.equal(leaderTask.unread, false);
  assert.equal(leaderTask.acknowledgedAt, ownerTask.acknowledgedAt);
  state.leaderAck = { key, revision: initial.revision, acknowledgedAt: ownerTask.acknowledgedAt };
  await saveJson(statePath, state);
}

if (process.argv.includes("--leader-ack")) {
  const state = await readJson(statePath);
  assert.equal(state.phase, "prepared");
  await prepareLeaderAck(state);
  await verifyViews(state);
  await saveJson(preparedPath, snapshot());
  console.log("PASS: assigned leader reads the sales owner's acknowledged flag/revision/timestamp; leader cannot acknowledge and another leader cannot see the task.");
  process.exit(0);
}

if (process.argv.includes("--persisted")) {
  const state = await readJson(statePath);
  assert.equal(state.phase, "prepared");
  assert.deepEqual(snapshot(), await readJson(preparedPath), "Real backend restart changed persisted multi-member/leader data or non-target records");
  await verifyViews(state);
  console.log("PASS: real Java restart preserves shared project/member requests, independent completed events, leader assignment/scope, engineer confirmations and feedback-context privacy.");
  process.exit(0);
}

if (process.argv.includes("--cleanup")) {
  const state = await readJson(statePath), baseline = await readJson(baselinePath);
  assert(!state.cleanedAt && state.prefix === "統合確認・リーダー複数参加者");
  const variables = {};
  const predicates = state.fixtures.map((fixture, index) => {
    assert(/^DH-[0-9a-f]{8}-[0-9a-f-]{27}$/.test(fixture.projectId) && fixture.name.startsWith(`${state.prefix} `));
    Object.assign(variables, { [`project_${index}`]: fixture.projectId, [`name_${index}`]: hex(fixture.name), [`leader_${index}`]: fixture.leaderId ?? "" });
    const sortedMembers = [...fixture.members].sort((a, b) => a.studentId.localeCompare(b.studentId));
    const students = [], ids = [];
    sortedMembers.forEach((member, memberIndex) => {
      variables[`student_${index}_${memberIndex}`] = member.studentId;
      variables[`request_${index}_${memberIndex}`] = member.requestId;
      students.push(`:'student_${index}_${memberIndex}'`);
      ids.push(`:'request_${index}_${memberIndex}'`);
    });
    return `(p.id=:'project_${index}' AND p.name=convert_from(decode(:'name_${index}','hex'),'UTF8') AND p.leader_id IS NOT DISTINCT FROM NULLIF(:'leader_${index}','')
 AND (SELECT array_agg(r.student_id ORDER BY r.student_id) FROM interview_requests r WHERE r.project_id=p.id)=ARRAY[${students.join(",")}]::text[]
 AND (SELECT count(*) FROM interview_requests r WHERE r.project_id=p.id AND r.id IN (${ids.join(",")}))=${fixture.members.length})`;
  });
  assert(predicates.length > 0);
  const baselineHex = hex(JSON.stringify(baseline));
  sql(`BEGIN;
CREATE TEMP TABLE cleanup_baseline(data jsonb) ON COMMIT DROP;
INSERT INTO cleanup_baseline VALUES(convert_from(decode('${baselineHex}','hex'),'UTF8')::jsonb);
CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS SELECT p.id FROM projects p WHERE p.sales_id='sales-aoki' AND (${predicates.join(" OR ")});
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
-- Compare all remaining values before committing. No snapshot is ever restored.
SELECT 1/(CASE WHEN ${snapshotExpression}=(SELECT data FROM cleanup_baseline) THEN 1 ELSE 0 END) AS all_non_target_data_unchanged;
COMMIT;`, variables);
  assert.deepEqual(snapshot(), baseline);
  assert.equal(baseline.app_users.length, 12);
  await saveJson(statePath, { ...state, cleanedAt: new Date().toISOString() });
  console.log("PASS: cleaned only exact UUID/name/member-set/request/leader fixtures; inside-transaction full JSON comparison confirms all twelve users and every non-target value in nine business tables remain unchanged.");
  process.exit(0);
}

try { assert((await readJson(statePath)).cleanedAt, "Finish or clean the previous leader-multi fixture before preparing another"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const before = snapshot();
assert.equal(before.app_users.length, 12);
await saveJson(baselinePath, before);
const state = { phase: "starting", prefix: "統合確認・リーダー複数参加者", suffix: randomUUID(), fixtures: [] };
await saveJson(statePath, state);
const valid = { project: `${state.prefix} 原子性確認 ${state.suffix}`, summary: "無効な複数参加者依頼が何も保存しないことを確認します。", studentIds: [firstStudent, secondStudent], leaderId: firstLeader, candidates: [{ start: "2026-11-12T13:00", end: "2026-11-12T13:45" }] };
await request(sales, "/api/requests", { ...valid, studentIds: [firstStudent, firstStudent] }, 400);
await request(sales, "/api/requests", { ...valid, studentIds: [firstStudent, "unknown-student"] }, 400);
await request(sales, "/api/requests", { ...valid, leaderId: firstStudent }, 400);
const missingLeader = { ...valid }; delete missingLeader.leaderId;
await request(sales, "/api/requests", missingLeader, 400);
await request(sales, "/api/requests", { ...valid, studentIds: [] }, 400);
assert.deepEqual(snapshot(), before, "Rejected multi-member requests left partial projects, requests, candidates or notifications");
const primary = await createProject(state, "共同案件", [firstStudent, secondStudent], firstLeader);
const secondary = await createProject(state, "別リーダー案件", [secondStudent], secondLeader, true);
await createProject(state, "旧形式リーダー未割当", ["student-yamamoto"], null, true);
const a = primary.members.find(item => item.studentId === firstStudent), b = primary.members.find(item => item.studentId === secondStudent);
assert.equal(new Set([...a.slots, ...b.slots].map(item => item.id)).size, 4, "Member requests must not share candidate IDs");
await request(firstStudent, `/api/requests/${a.requestId}/respond`, { slotIds: [b.slots[0].id] }, 400);
await request(firstStudent, `/api/requests/${b.requestId}/respond`, { slotIds: [b.slots[0].id] }, 403);
await request(firstStudent, `/api/requests/${a.requestId}/respond`, { slotIds: [a.slots[0].id] });
let data = await dashboard(sales);
assert.equal(data.requests.find(item => item.id === a.requestId).status, "responded");
assert.equal(data.requests.find(item => item.id === b.requestId).status, "requested", "One member's response changed another member's state");
const confirmedA = await request(sales, `/api/requests/${a.requestId}/confirm`, { slotId: a.slots[0].id, url: "https://meet.example/multi-first" }); a.eventId = confirmedA.eventId;
assert.equal((await dashboard(sales)).requests.find(item => item.id === b.requestId).status, "requested");
await request(secondStudent, `/api/requests/${b.requestId}/respond`, { slotIds: [b.slots[1].id] });
const confirmedB = await request(sales, `/api/requests/${b.requestId}/confirm`, { slotId: b.slots[1].id, url: "https://meet.example/multi-second" }); b.eventId = confirmedB.eventId;
assert.notEqual(getEvent(await dashboard(sales), a.eventId).stamp, getEvent(await dashboard(sales), b.eventId).stamp);
for (const member of primary.members) {
  member.secret = `PRIVATE_IMPRESSION_${member.studentId}_${state.suffix}`;
  member.question = `共同案件の質問 ${member.studentId} ${state.suffix}`;
  await request(member.studentId, `/api/events/${member.eventId}/feedback`, { duties: `担当業務 ${member.studentId}`, process: "設計・実装", remote: "週2日", impression: member.secret, questions: [member.question] });
}
state.legacyQuestionId = `Q-${randomUUID()}`;
state.legacyContext = `LEGACY_SHARED_CONTEXT_${state.suffix}`;
sql("INSERT INTO interview_questions(id,project_id,title,tag,context,display_order) VALUES(:'question',:'project',convert_from(decode(:'title_hex','hex'),'UTF8'),'legacy',:'context',999);", { question: state.legacyQuestionId, project: primary.projectId, title_hex: hex(`旧形式の共有質問 ${state.suffix}`), context: state.legacyContext });
await saveJson(statePath, state);
const leaderBefore = await dashboard(firstLeader);
assert(leaderBefore.tasks.some(item => item.eventId === a.eventId && item.action === "entry"));
assert(leaderBefore.tasks.some(item => item.eventId === b.eventId && item.action === "entry"));
const readOnlyBefore = snapshot();
for (const [endpoint, body] of [
  ["/api/requests", valid],
  [`/api/requests/${a.requestId}/respond`, { slotIds: [a.slots[0].id] }],
  [`/api/requests/${a.requestId}/confirm`, { slotId: a.slots[0].id, url: "https://meet.example/forbidden" }],
  [`/api/events/${a.eventId}/feedback`, { duties: "x", process: "x", remote: "x", impression: "x", questions: [] }],
  [`/api/events/${a.eventId}/entry`, { result: "rejected" }],
  [`/api/events/${a.eventId}/acknowledge`, {}],
  [`/api/tasks/result-${a.eventId}/acknowledge`, { revision: 1 }],
]) await request(firstLeader, endpoint, body, 403);
await request(secondLeader, `/api/requests/${a.requestId}/respond`, { slotIds: [a.slots[0].id] }, 403);
assert.deepEqual(snapshot(), readOnlyBefore, "Leader POST attempts changed persisted data");
const entry = await request(sales, `/api/events/${a.eventId}/entry`, { result: "passed", when: "2026-11-16T09:30", where: "共同案件 1階受付", memo: "担当者へご連絡ください。" }); a.entryId = entry.eventId;
await request(sales, `/api/events/${b.eventId}/entry`, { result: "rejected" });
await request(firstStudent, `/api/events/${a.eventId}/acknowledge`, {});
await request(firstStudent, `/api/events/${a.entryId}/acknowledge`, {});
await request(secondStudent, `/api/events/${b.eventId}/acknowledge`, {});
await prepareLeaderAck(state);
state.phase = "prepared";
await saveJson(statePath, state);
await verifyViews(state);
await saveJson(preparedPath, snapshot());
console.log("PASS: atomic multi-member project creation and legacy payloads; independent candidates/responses/confirmation; assigned-leader scope/all POST403; student feedback/context privacy with shared question titles and legacy context; completed engineer-confirmed events remain visible to assigned leader.");
console.log("Prepared fixtures retained. Restart Java, run --persisted, then --cleanup; all non-target snapshots will be compared inside the cleanup transaction.");
