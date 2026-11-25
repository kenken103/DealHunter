import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Removes only this run's identified projects. --prepare / --persisted checks
// a real Java restart; --cleanup also removes retained browser fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/recruitment-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const prefix = `Recruitment verification ${randomUUID()}`;
const sales = "sales-aoki", sato = "leader-sato", suzuki = "leader-suzuki";
const taka = "student-takahashi", yama = "student-yamamoto", mori = "student-mori", inoue = "student-inoue", sasaki = "student-sasaki";
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements", "leader_members", "recruitments", "recruitment_candidate_slots", "app_migrations"];
const rowExpression = table => ["request_attachments", "project_attachments"].includes(table) ? "(to_jsonb(t)-'content')||jsonb_build_object('contentHash',md5(t.content))" : "to_jsonb(t)";
const snapshotExpression = `jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(${rowExpression(table)} ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})`;
let fixtures = [];

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "15432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const snapshot = () => JSON.parse(sql(`SELECT ${snapshotExpression}::text;`));
const unchanged = (before, message) => assert.equal(JSON.stringify(snapshot()), JSON.stringify(before), message);
async function request(user, endpoint, body, expected = 200) {
  const response = await fetch("http://127.0.0.1:8080" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (endpoint === "/api/requests" && data.projectId && body?.project?.startsWith(prefix)) {
    assert(/^DH-[0-9a-f-]{36}$/.test(data.projectId), "Unexpected fixture project ID");
    if (!fixtures.some(item => item.id === data.projectId)) fixtures.push({ id: data.projectId, name: body.project });
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${endpoint}: expected ${statuses.join("/")}, got ${response.status}: ${data.error ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
const draft = (label, overrides = {}) => ({ project: `${prefix} ${label}`, upperCompany: "検証用上位会社", summary: "リーダーの面談者選定から日程回答までの統合確認です。", assignmentMode: "leader", leaderId: sato, studentIds: [], scheduleMode: "availability", candidates: [], ...overrides });
const create = (label, overrides) => request(sales, "/api/requests", draft(label, overrides));
const assign = (user, id, ids, status = 200) => request(user, `/api/recruitments/${id}/assign`, { studentIds: ids }, status);
const recruitment = (data, id) => {
  const value = data.recruitments.find(item => item.id === id);
  assert(value, "Recruitment was not persisted or visible");
  return value;
};
const ownRequests = (data, projectId) => data.requests.filter(item => item.projectId === projectId);

function cleanup(targets) {
  if (!targets.length) return;
  for (const item of targets) assert(/^DH-[0-9a-f-]{36}$/.test(item.id) && /^Recruitment verification [0-9a-f-]{36} /.test(item.name), "Refusing cleanup of an unrecognized project");
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
DELETE FROM recruitments WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM cleanup_targets);
DELETE FROM projects WHERE id IN (SELECT id FROM cleanup_targets);
COMMIT;`, { fixtures: JSON.stringify(targets), count: targets.length });
}
function ownRows(data, targets) {
  const ids = new Set(targets.map(item => item.id));
  return {
    ...Object.fromEntries(["projects", "requests", "recruitments", "events", "tasks"].map(key => [key, data[key].filter(item => ids.has(key === "projects" ? item.id : item.projectId))])),
    notifications: data.notifications.filter(item => item.lines.some(line => line.label === "案件" && targets.some(target => target.name === line.value))),
  };
}

if (process.argv.includes("--persisted") || process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "prepared", "No retained recruitment fixture exists");
  fixtures = state.fixtures;
  try {
    if (!process.argv.includes("--cleanup")) {
      assert.equal(JSON.stringify(ownRows(await dashboard(sales), fixtures)), JSON.stringify(state.expected), "Restart changed stored recruitment/request state");
      assert.equal(JSON.stringify((await dashboard(sato)).teamMembers), JSON.stringify(state.teamMembers), "Restart changed approved team membership");
      console.log("PASS: actual Java restart preserved team membership, pending/assigned recruitments and per-person scheduling state.");
    }
  } finally {
    if (!process.argv.includes("--keep")) {
      cleanup(fixtures);
      unchanged(state.baseline, "Unrelated stored records changed during recruitment verification");
      await writeFile(statePath, JSON.stringify({ phase: "cleaned" }) + "\n", "utf8");
    }
  }
  process.exit(0);
}

const baseline = snapshot();
let keep = false;
try {
  // Exercise reseeding inside one rolled-back transaction: changes to an
  // existing team must never be silently reverted on a later app restart.
  const seedSql = await readFile(path.join(root, "backend/seed-users.sql"), "utf8");
  sql(`BEGIN;
UPDATE leader_members SET active=false WHERE student_id='student-takahashi';
UPDATE leader_members SET leader_id='leader-suzuki' WHERE student_id='student-yamamoto';
DELETE FROM leader_members WHERE student_id='student-mori';
${seedSql}
SELECT 1/(CASE WHEN
EXISTS(SELECT 1 FROM leader_members WHERE student_id='student-takahashi' AND NOT active) AND
EXISTS(SELECT 1 FROM leader_members WHERE student_id='student-yamamoto' AND leader_id='leader-suzuki') AND
NOT EXISTS(SELECT 1 FROM leader_members WHERE student_id='student-mori')
THEN 1 ELSE 0 END);
ROLLBACK;`);
  unchanged(baseline, "Membership reseeding check changed existing records");
  const teams = [[sato, [taka, yama, mori, "student-ito", "student-kobayashi"]], [suzuki, [sasaki, "student-tanaka", "student-kimura", inoue]]];
  for (const [user, ids] of teams) assert.deepEqual((await dashboard(user)).teamMembers.map(item => item.id).sort(), ids.sort(), "Leader sees a wrong team");
  for (const [label, overrides] of [
    ["unknown-mode", { assignmentMode: "invalid" }], ["no-leader", { leaderId: "" }],
    ["student-leader", { leaderId: taka }], ["preselected", { studentIds: [taka] }],
    ["legacy-preselected", { studentId: taka }], ["fixed-empty", { scheduleMode: "candidates" }],
  ]) await request(sales, "/api/requests", draft(label, overrides), 400);
  unchanged(baseline, "Rejected creates left partial records");

  const inquiry = await create("unrestricted");
  assert.match(inquiry.recruitmentId, /^A-[0-9a-f-]{36}$/);
  assert.deepEqual(inquiry.requestIds, []);
  assert(inquiry.preview.lines.some(item => item.value.includes("/leader?project=")), "Initial preview must address the leader");
  let data = await dashboard(sales);
  assert.equal(recruitment(data, inquiry.recruitmentId).status, "pending");
  assert.deepEqual(ownRequests(data, inquiry.projectId), []);
  const task = data.tasks.find(item => item.recruitmentId === inquiry.recruitmentId);
  assert(task && task.action === "assign" && task.owner === "リーダー" && task.unread, "Pending recruitment must create a leader task");
  assert(recruitment(await dashboard(sato), inquiry.recruitmentId));
  for (const user of [taka, yama, suzuki]) {
    const hidden = await dashboard(user);
    assert(!hidden.projects.some(item => item.id === inquiry.projectId), "Unselected/foreign viewers saw a pending project");
    assert(!hidden.recruitments.some(item => item.id === inquiry.recruitmentId), "Unselected/foreign viewers saw recruitment details");
  }
  const denied = snapshot();
  for (const user of [sales, taka, suzuki]) await assign(user, inquiry.recruitmentId, [taka], 403);
  for (const ids of [null, taka, [12], [], [taka, taka], [inoue], [taka, inoue], [sato], ["not-a-person"]]) await assign(sato, inquiry.recruitmentId, ids, 400);
  await request(sato, `/api/recruitments/${inquiry.recruitmentId}/assign`, { studentIds: [taka], extra: true }, 400);
  await request(sato, "/api/requests", draft("leader-create"), 403);
  unchanged(denied, "Rejected selections changed stored records");
  await request(sales, `/api/tasks/${task.key}/acknowledge`, { revision: task.revision });
  assert.equal((await dashboard(sales)).tasks.find(item => item.key === task.key).unread, false);

  const assigned = await assign(sato, inquiry.recruitmentId, [taka, yama]);
  assert.equal(assigned.requestIds.length, 2);
  assert.equal(assigned.previews.length, 2);
  assert(assigned.salesPreview, "Assignment must notify sales in a saved preview");
  data = await dashboard(sales);
  assert.equal(recruitment(data, inquiry.recruitmentId).status, "assigned");
  assert.deepEqual(recruitment(data, inquiry.recruitmentId).studentIds.slice().sort(), [taka, yama].sort());
  assert(!data.tasks.some(item => item.key === task.key), "Selection task remained active after assignment");
  await request(sales, `/api/tasks/${task.key}/acknowledge`, { revision: task.revision }, 409);
  await assign(sato, inquiry.recruitmentId, [mori], 409);
  const members = ownRequests(data, inquiry.projectId);
  assert.equal(members.length, 2);
  for (const item of members) {
    assert.equal(item.status, "requested"); assert.equal(item.scheduleMode, "availability");
    assert.deepEqual(item.requestedDates, []); assert.deepEqual(item.candidates, []);
    const personal = await dashboard(item.studentId);
    assert.equal(ownRequests(personal, inquiry.projectId).length, 1);
    assert.deepEqual(personal.recruitments, [], "Selected engineers saw team recruitment details");
    assert.deepEqual(personal.teamMembers, []);
  }
  assert(!(await dashboard(mori)).projects.some(item => item.id === inquiry.projectId), "Unselected teammate saw the project");
  const first = members.find(item => item.studentId === taka);
  await request(taka, `/api/requests/${first.id}/respond`, { proposals: [{ start: "2026-12-01T13:00" }] });
  const answered = (await dashboard(sales)).requests.find(item => item.id === first.id);
  assert.equal(answered.candidates[0].end, null);
  await request(sales, `/api/requests/${first.id}/confirm`, { slotId: answered.candidates[0].id, url: "https://meet.example/recruitment-verification" });
  assert((await dashboard(taka)).events.some(item => item.requestId === first.id), "Selected engineer's confirmed event was not created");
  assert.equal((await dashboard(yama)).requests.find(item => item.projectId === inquiry.projectId).status, "requested", "Another member's state was changed");

  const fixed = await create("fixed", { leaderId: suzuki, scheduleMode: "candidates", candidates: [{ start: "2026-12-02T14:00" }, { start: "2026-12-02T15:00", end: "2026-12-02T16:00" }] });
  const concurrent = await Promise.all([assign(suzuki, fixed.recruitmentId, [inoue, sasaki], [200, 409]), assign(suzuki, fixed.recruitmentId, [inoue, sasaki], [200, 409])]);
  assert.equal(concurrent.filter(item => item.requestIds?.length === 2).length, 1, "Concurrent selection succeeded more than once");
  const fixedMembers = ownRequests(await dashboard(sales), fixed.projectId);
  assert.equal(fixedMembers.length, 2);
  for (const item of fixedMembers) {
    assert.equal(item.scheduleMode, "candidates");
    assert.deepEqual(item.candidates.map(slot => [slot.start, slot.end]), [["2026-12-02T14:00", null], ["2026-12-02T15:00", "2026-12-02T16:00"]]);
  }
  assert.notEqual(fixedMembers[0].candidates[0].id, fixedMembers[1].candidates[0].id, "Members share mutable slots");
  await request(inoue, `/api/requests/${fixedMembers.find(item => item.studentId === inoue).id}/respond`, { slotIds: [fixedMembers.find(item => item.studentId === inoue).candidates[0].id] });

  const dated = await create("dated", { requestedDates: ["2026-12-04", "2026-12-03"] });
  await assign(sato, dated.recruitmentId, [mori]);
  const datedRequest = ownRequests(await dashboard(sales), dated.projectId)[0];
  assert.deepEqual(datedRequest.requestedDates, ["2026-12-03", "2026-12-04"]);
  await request(mori, `/api/requests/${datedRequest.id}/respond`, { proposals: [{ start: "2026-12-05T11:00" }] }, 400);
  await request(mori, `/api/requests/${datedRequest.id}/respond`, { proposals: [{ start: "2026-12-04T11:00" }] });

  const direct = await create("direct", { assignmentMode: "direct", studentIds: [taka] });
  assert.equal(direct.requestIds.length, 1);
  assert(!(await dashboard(sales)).recruitments.some(item => item.projectId === direct.projectId), "Direct flow created an unwanted recruitment");
  const browser = await create("browser-pending", { requestedDates: ["2026-12-07", "2026-12-08"] });
  assert.equal(recruitment(await dashboard(sales), browser.recruitmentId).status, "pending");
  if (process.argv.includes("--prepare")) {
    await writeFile(statePath, JSON.stringify({ phase: "prepared", fixtures, baseline, browser, expected: ownRows(await dashboard(sales), fixtures), teamMembers: (await dashboard(sato)).teamMembers }, null, 2) + "\n", "utf8");
    keep = true;
  }
  console.log("PASS: leader-only recruitment, approved team scope, invalid/foreign rejection, task acknowledgement, concurrent one-time assignment, independent schedule templates/responses, confirmation and direct-flow compatibility.");
} finally {
  if (!keep) { cleanup(fixtures); unchanged(baseline, "Existing records changed during recruitment verification"); }
}
