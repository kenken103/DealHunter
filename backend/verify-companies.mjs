import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Default: check company fields and remove only this run's generated cases.
// Actual restart verification: --prepare, restart Java, then --persisted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/companies-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const prefix = `Company verification ${randomUUID()}`;
const sales = "sales-aoki", leader = "leader-sato", otherLeader = "leader-suzuki";
const first = "student-takahashi", second = "student-yamamoto", third = "student-mori", outsider = "student-inoue";
const viewers = [sales, leader, otherLeader, first, second, third, outsider];
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements", "leader_members", "recruitments", "recruitment_candidate_slots", "app_migrations"];
const rowExpression = table => ["request_attachments", "project_attachments"].includes(table)
  ? "(to_jsonb(t)-'content')||jsonb_build_object('contentHash',md5(t.content))"
  : table === "app_users" ? "(to_jsonb(t)-'password_hash')||jsonb_build_object('credentialFingerprint',md5(t.password_hash))" : "to_jsonb(t)";
const snapshotExpression = `jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(${rowExpression(table)} ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})`;
let fixtures = [];

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "15432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, "Company verification fixture SQL failed");
  return result.stdout.trim();
}
const snapshot = () => JSON.parse(sql(`SELECT ${snapshotExpression}::text;`));
const unchanged = (before, message) => assert(JSON.stringify(snapshot()) === JSON.stringify(before), message);
async function request(user, endpoint, body, expected = 200) {
  const response = await fetch("http://127.0.0.1:8080" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  // Track an unexpected successful create before asserting the status, too.
  if (endpoint === "/api/requests" && data.projectId && body?.project?.startsWith(prefix)) {
    assert(/^DH-[0-9a-f-]{36}$/.test(data.projectId), "Unexpected generated project identifier");
    if (!fixtures.some(item => item.id === data.projectId)) fixtures.push({ id: data.projectId, name: body.project });
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${endpoint}: expected HTTP ${statuses.join("/")}, got ${response.status}: ${data.error ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
const draft = (label, overrides = {}) => ({ project: `${prefix} ${label}`, summary: "Company field preservation verification fixture.", upperCompany: "上位会社株式会社", assignmentMode: "direct", studentIds: [first], leaderId: leader, scheduleMode: "availability", candidates: [], ...overrides });
const create = (label, overrides) => request(sales, "/api/requests", draft(label, overrides));
const respond = (user, id, body) => request(user, `/api/requests/${id}/respond`, body);
const confirm = (id, slotId) => request(sales, `/api/requests/${id}/confirm`, { slotId, url: "https://meet.example/company-verification" });
const requestsFor = (data, id) => data.requests.filter(item => item.projectId === id);

function companies(record, upperCompany, endCompany) {
  assert(record, "Company-bearing project, request, event or recruitment was missing");
  assert.equal(typeof record.upperCompany, "string", "Upper company must be exposed as text, including old projects");
  assert.equal(typeof record.endCompany, "string", "End company must be exposed as text, including old projects");
  assert.equal(record.upperCompany, upperCompany, "Stored upper company differs from the accepted input");
  assert.equal(record.endCompany, endCompany, "Stored end company differs from the accepted input");
}
async function visibleCompanies(user, id, upperCompany, endCompany, expectedRequests) {
  const data = await dashboard(user);
  companies(data.projects.find(item => item.id === id), upperCompany, endCompany);
  const requests = requestsFor(data, id);
  if (expectedRequests !== undefined) assert.equal(requests.length, expectedRequests, "A viewer received another person's requests");
  for (const item of [...requests, ...data.events.filter(item => item.projectId === id), ...data.recruitments.filter(item => item.projectId === id)]) companies(item, upperCompany, endCompany);
  return data;
}
async function hiddenProject(user, id) {
  const data = await dashboard(user);
  for (const collection of ["projects", "requests", "events", "recruitments", "tasks"]) assert(!data[collection].some(item => (collection === "projects" ? item.id : item.projectId) === id), "An unrelated viewer received a project or its company information");
}
function storedCompanies(id) {
  return JSON.parse(sql("SELECT jsonb_build_object('upperCompany',upper_company,'endCompany',end_company)::text FROM projects WHERE id=:'id';", { id }));
}
function cleanup(targets) {
  if (!targets.length) return;
  for (const item of targets) assert(/^DH-[0-9a-f-]{36}$/.test(item.id) && /^Company verification [0-9a-f-]{36} /.test(item.name), "Refusing cleanup of an unidentified project");
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
async function viewerState(targets) {
  const entries = await Promise.all(viewers.map(async user => [user, ownRows(await dashboard(user), targets)]));
  return Object.fromEntries(entries);
}

if (process.argv.includes("--persisted") || process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "prepared", "No retained company verification exists");
  fixtures = state.fixtures;
  try {
    if (!process.argv.includes("--cleanup")) {
      assert(JSON.stringify(await viewerState(fixtures)) === JSON.stringify(state.expected), "Actual restart changed company fields, scoped records, scheduling or notification previews");
      console.log("PASS: actual Java restart preserved company fields, old blank-company projects and each viewer's scoped workflow records.");
    }
  } finally {
    if (!process.argv.includes("--keep")) {
      cleanup(fixtures);
      unchanged(state.baseline, "Pre-existing records changed during company verification");
      await writeFile(statePath, JSON.stringify({ phase: "cleaned" }) + "\n", "utf8");
      console.log("PASS: removed only this run's generated projects; all pre-existing database rows were preserved.");
    }
  }
  process.exit(0);
}

try {
  const retained = JSON.parse(await readFile(statePath, "utf8"));
  assert.notEqual(retained.phase, "prepared", "A company verification is retained; use --persisted or --cleanup before another run");
} catch (error) { if (error?.code !== "ENOENT") throw error; }
const baseline = snapshot();
let keep = false;
try {
  // A newly created request always needs an upper company, for all payloads.
  for (const [label, overrides] of [
    ["missing-upper-direct", { upperCompany: undefined }],
    ["missing-upper-leader", { upperCompany: undefined, assignmentMode: "leader", studentIds: [] }],
    ["missing-upper-legacy", { upperCompany: undefined, studentIds: undefined, studentId: first, leaderId: undefined }],
    ...[null, 42, false, [], {}, "", "   ", "　\u00a0\u2003　", "上".repeat(201)].map((value, index) => [`invalid-upper-${index}`, { upperCompany: value }]),
    ...[null, 42, false, [], {}, "終".repeat(201)].map((value, index) => [`invalid-end-${index}`, { endCompany: value }]),
  ]) await request(sales, "/api/requests", draft(label, overrides), 400);
  unchanged(baseline, "Invalid company inputs left partially saved workflow rows");

  const omitted = await create("end-omitted", { upperCompany: "上位のみ株式会社", scheduleMode: "candidates", candidates: [{ start: "2026-12-14T10:00" }] });
  companies(storedCompanies(omitted.projectId), "上位のみ株式会社", "");
  let data = await visibleCompanies(first, omitted.projectId, "上位のみ株式会社", "", 1);
  let item = requestsFor(data, omitted.projectId)[0];
  await respond(first, item.id, { slotIds: [item.candidates[0].id] });
  const omittedEvent = await confirm(item.id, item.candidates[0].id);
  data = await visibleCompanies(sales, omitted.projectId, "上位のみ株式会社", "", 1);
  companies(data.events.find(event => event.key === omittedEvent.eventId), "上位のみ株式会社", "");
  await hiddenProject(second, omitted.projectId);

  const legacyPayload = await create("end-empty-legacy-payload", { upperCompany: "旧形式API株式会社", endCompany: "", studentIds: undefined, studentId: first, leaderId: undefined });
  await visibleCompanies(first, legacyPayload.projectId, "旧形式API株式会社", "", 1);
  companies(storedCompanies(legacyPayload.projectId), "旧形式API株式会社", "");

  const upper = "上位会社 株式会社", end = "エンド会社 合同会社";
  const multi = await create("unicode-trim-multi", { upperCompany: `　\u00a0\u2003${upper}\u2003　`, endCompany: `\u00a0　${end}\u2003 `, studentIds: [first, second] });
  companies(storedCompanies(multi.projectId), upper, end);
  for (const user of [sales, leader]) await visibleCompanies(user, multi.projectId, upper, end, 2);
  for (const user of [first, second]) await visibleCompanies(user, multi.projectId, upper, end, 1);
  await hiddenProject(outsider, multi.projectId);
  await hiddenProject(otherLeader, multi.projectId);
  item = requestsFor(await dashboard(first), multi.projectId)[0];
  await respond(first, item.id, { proposals: [{ start: "2026-12-15T13:00" }] });
  item = requestsFor(await dashboard(sales), multi.projectId).find(value => value.studentId === first);
  const multiEvent = await confirm(item.id, item.candidates[0].id);
  for (const user of [sales, leader, first]) {
    data = await visibleCompanies(user, multi.projectId, upper, end, user === first ? 1 : 2);
    companies(data.events.find(event => event.key === multiEvent.eventId), upper, end);
  }
  assert.equal(requestsFor(await dashboard(second), multi.projectId)[0].status, "requested", "Another person's response state changed");

  const boundary = "社".repeat(200);
  const max = await create("200-character-boundary", { upperCompany: boundary, endCompany: boundary });
  companies(storedCompanies(max.projectId), boundary, boundary);
  await visibleCompanies(sales, max.projectId, boundary, boundary, 1);
  const same = await create("same-company", { upperCompany: "同一会社株式会社", endCompany: "同一会社株式会社" });
  await visibleCompanies(first, same.projectId, "同一会社株式会社", "同一会社株式会社", 1);

  const recruitment = await create("leader-selection", { upperCompany: "選定元会社株式会社", endCompany: "選定先会社株式会社", assignmentMode: "leader", studentIds: [], requestedDates: ["2026-12-17", "2026-12-18"] });
  for (const user of [sales, leader]) {
    data = await visibleCompanies(user, recruitment.projectId, "選定元会社株式会社", "選定先会社株式会社", 0);
    companies(data.recruitments.find(value => value.id === recruitment.recruitmentId), "選定元会社株式会社", "選定先会社株式会社");
  }
  for (const user of [first, second, third, outsider, otherLeader]) await hiddenProject(user, recruitment.projectId);
  await request(leader, `/api/recruitments/${recruitment.recruitmentId}/assign`, { studentIds: [second, third] });
  for (const user of [sales, leader, second, third]) await visibleCompanies(user, recruitment.projectId, "選定元会社株式会社", "選定先会社株式会社", user === sales || user === leader ? 2 : 1);
  await hiddenProject(first, recruitment.projectId);
  item = requestsFor(await dashboard(third), recruitment.projectId)[0];
  await respond(third, item.id, { proposals: [{ start: "2026-12-17T14:00" }] });
  item = requestsFor(await dashboard(sales), recruitment.projectId).find(value => value.studentId === third);
  const assignedEvent = await confirm(item.id, item.candidates[0].id);
  data = await visibleCompanies(leader, recruitment.projectId, "選定元会社株式会社", "選定先会社株式会社", 2);
  companies(data.events.find(event => event.key === assignedEvent.eventId), "選定元会社株式会社", "選定先会社株式会社");

  // Simulate an old project on this run's fixture only. Migration permits its
  // blank company fields, and later workflow operations must remain usable.
  const old = await create("old-blank-project", { studentIds: undefined, studentId: first });
  sql("UPDATE projects SET upper_company='',end_company='' WHERE id=:'id' AND name=:'name' AND sales_id='sales-aoki';", { id: old.projectId, name: `${prefix} old-blank-project` });
  for (const user of [sales, leader, first]) await visibleCompanies(user, old.projectId, "", "", 1);
  item = requestsFor(await dashboard(first), old.projectId)[0];
  await respond(first, item.id, { proposals: [{ start: "2026-12-19T11:00" }] });
  item = requestsFor(await dashboard(sales), old.projectId)[0];
  const oldEvent = await confirm(item.id, item.candidates[0].id);
  await request(sales, `/api/events/${oldEvent.eventId}/entry`, { result: "passed", when: "2026-12-21T09:00", where: "Verification office", memo: "Old company metadata compatibility" });
  data = await visibleCompanies(first, old.projectId, "", "", 1);
  assert.equal(data.events.filter(value => value.projectId === old.projectId).length, 2, "Old blank-company project lost its interview or entry history");

  const pending = await create("pending-end-omitted", { upperCompany: "未選定会社株式会社", assignmentMode: "leader", studentIds: [] });
  data = await visibleCompanies(leader, pending.projectId, "未選定会社株式会社", "", 0);
  companies(data.recruitments.find(value => value.id === pending.recruitmentId), "未選定会社株式会社", "");
  await hiddenProject(first, pending.projectId);

  if (process.argv.includes("--prepare")) {
    await writeFile(statePath, JSON.stringify({ phase: "prepared", fixtures, baseline, expected: await viewerState(fixtures) }, null, 2) + "\n", "utf8");
    keep = true;
  }
  console.log("PASS: required upper company, optional end company, atomic input validation, Unicode trimming/200-character boundary, same-company values, scoped direct/multiple/recruited workflows and old blank-company compatibility.");
} finally {
  if (!keep) {
    cleanup(fixtures);
    unchanged(baseline, "Pre-existing records changed during company verification");
    console.log("PASS: removed only this run's generated projects; all pre-existing database rows were preserved.");
  }
}
