import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run against the isolated local demo. Default removes only generated fixtures.
// --prepare retains those fixtures for browser/restart checks; --cleanup removes them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/excel-workflow-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const password = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const sales = "sales-aoki", leader = "leader-sato", first = "student-takahashi", second = "student-yamamoto", outsider = "student-inoue";
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements", "leader_members", "recruitments", "recruitment_candidate_slots", "app_migrations"];
const prefix = `Excel workflow verification ${randomUUID()}`;
let fixtures = [];
let generatedUsers = [];

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "15432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Excel workflow fixture SQL failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

const rowExpression = table => ["request_attachments", "project_attachments"].includes(table)
  ? "(to_jsonb(t)-'content')||jsonb_build_object('contentHash',md5(t.content))"
  : table === "app_users" ? "(to_jsonb(t)-'password_hash')||jsonb_build_object('credentialFingerprint',md5(t.password_hash))" : "to_jsonb(t)";
function fingerprintsExpression(predicates = {}) {
  return `jsonb_build_object(${tables.map(table => `'${table}',(SELECT md5(COALESCE(jsonb_agg(${rowExpression(table)} ORDER BY (${rowExpression(table)})::text)::text,'[]')) FROM ${table} t${predicates[table] ? ` WHERE ${predicates[table]}` : ""})`).join(",")})`;
}
const fingerprints = () => JSON.parse(sql(`SELECT ${fingerprintsExpression()}::text;`));

async function request(user, endpoint, body, expected = 200, extraHeaders = {}) {
  const response = await fetch("http://127.0.0.1:8080" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, "X-DealHunter-User": user, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  // Track an unexpected successful create before reporting a failed assertion.
  if (endpoint === "/api/requests" && data.projectId && body?.project?.startsWith(prefix)) {
    assert(/^DH-[0-9a-f-]{36}$/.test(data.projectId), "Unexpected generated project identifier");
    if (!fixtures.some(item => item.id === data.projectId)) fixtures.push({ id: data.projectId, name: body.project });
  }
  if (endpoint === "/api/auth/register" && data.user?.id && /^ui-excel\.[0-9a-f-]{36}@legarea\.jp$/.test(body?.email ?? "")) {
    generatedUsers.push({ id: data.user.id, name: body.name, email: body.email });
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${endpoint}: expected HTTP ${statuses.join("/")}, got ${response.status}: ${data.error ?? data.message ?? "unexpected response"}`);
  return data;
}
const dashboard = user => request(user, "/api/dashboard");
const findRequest = (data, id) => { const record = data.requests.find(item => item.id === id); assert(record, "Fixture request missing"); return record; };
const findEvent = (data, id) => { const record = data.events.find(item => item.key === id); assert(record, "Fixture event missing"); return record; };
const acknowledge = (user, id, expected = 200) => request(user, `/api/events/${id}/acknowledge`, {}, expected);

// Windows psql -v arguments must remain ASCII even for fixture names containing Japanese or emoji.
const asciiJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

function cleanup(targets, users = []) {
  if (!targets.length && !users.length) return;
  for (const fixture of targets) assert(/^DH-[0-9a-f-]{36}$/.test(fixture.id) && /^Excel workflow verification [0-9a-f-]{36} /.test(fixture.name), "Refusing cleanup of an unidentified project");
  for (const user of users) assert(/^[A-Za-z0-9_-]+$/.test(user.id) && /^Excel UI verification [0-9a-f-]{36}$/.test(user.name) && /^ui-excel\.[0-9a-f-]{36}@legarea\.jp$/.test(user.email), "Refusing cleanup of an unidentified temporary account");
  const protectedPredicates = {
    app_users: "t.id NOT IN(SELECT id FROM cleanup_users)",
    leader_members: "t.student_id NOT IN(SELECT id FROM cleanup_users) AND t.leader_id NOT IN(SELECT id FROM cleanup_users)",
    projects: "t.id NOT IN(SELECT id FROM cleanup_targets)",
    scheduled_events: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    interview_questions: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    pending_tasks: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    interview_requests: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    candidate_slots: "t.request_id NOT IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_targets))",
    request_attachments: "t.request_id NOT IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_targets))",
    project_attachments: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    interview_feedback: "t.event_id NOT IN(SELECT id FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_targets))",
    notification_previews: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    task_acknowledgements: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    recruitments: "t.project_id NOT IN(SELECT id FROM cleanup_targets)",
    recruitment_candidate_slots: "t.recruitment_id NOT IN(SELECT id FROM recruitments WHERE project_id IN(SELECT id FROM cleanup_targets))",
  };
  sql(`BEGIN;
LOCK TABLE ${tables.join(",")} IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE cleanup_targets ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN jsonb_to_recordset(:'fixtures'::jsonb) f(id text,name text)
ON p.id=f.id AND p.name=f.name WHERE p.sales_id='sales-aoki';
SELECT 1/(CASE WHEN count(*)=:'count'::integer THEN 1 ELSE 0 END) FROM cleanup_targets;
CREATE TEMP TABLE cleanup_users ON COMMIT DROP AS
SELECT u.id FROM app_users u JOIN jsonb_to_recordset(:'users'::jsonb) f(id text,name text,email text)
ON u.id=f.id AND u.display_name=f.name AND u.email=f.email;
SELECT 1/(CASE WHEN count(*)=:'user_count'::integer THEN 1 ELSE 0 END) FROM cleanup_users;
CREATE TEMP VIEW protected_rows AS SELECT ${fingerprintsExpression(protectedPredicates)} AS document;
CREATE TEMP TABLE protected_before ON COMMIT DROP AS SELECT document FROM protected_rows;
DELETE FROM task_acknowledgements WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM notification_previews WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM interview_questions WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM interview_feedback WHERE event_id IN(SELECT id FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_targets));
DELETE FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_targets) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM candidate_slots WHERE request_id IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_targets));
DELETE FROM request_attachments WHERE request_id IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_targets));
DELETE FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM recruitment_candidate_slots WHERE recruitment_id IN(SELECT id FROM recruitments WHERE project_id IN(SELECT id FROM cleanup_targets));
DELETE FROM recruitments WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM pending_tasks WHERE project_id IN(SELECT id FROM cleanup_targets);
DELETE FROM projects WHERE id IN(SELECT id FROM cleanup_targets);
DELETE FROM leader_members WHERE student_id IN(SELECT id FROM cleanup_users) OR leader_id IN(SELECT id FROM cleanup_users);
DELETE FROM app_users WHERE id IN(SELECT id FROM cleanup_users);
SELECT 1/(CASE WHEN b.document=v.document THEN 1 ELSE 0 END) FROM protected_before b CROSS JOIN protected_rows v;
COMMIT;`, { fixtures: asciiJson(targets), count: String(targets.length), users: asciiJson(users), user_count: String(users.length) });
}

// Refuse any mutation unless this is the project's own isolated PostgreSQL cluster.
const actualCluster = sql("SELECT current_setting('data_directory');");
assert.equal(path.resolve(actualCluster).toLowerCase(), path.join(root, ".local/postgres").toLowerCase(), "Unexpected PostgreSQL cluster; refusing fixture mutations");

if (process.argv.includes("--cleanup")) {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert(saved.version === 1 && !saved.cleanedAt && Array.isArray(saved.fixtures) && saved.fixtures.length > 0, "Unexpected or already cleaned fixture state");
  cleanup(saved.fixtures, saved.generatedUsers ?? []);
  await writeFile(statePath, JSON.stringify({ ...saved, cleanedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
  console.log("PASS: removed only this verification's exact generated cases and temporary accounts; every non-target table fingerprint matched the locked cleanup baseline.");
  process.exit(0);
}

if (process.argv.includes("--persisted")) {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert(saved.version === 1 && saved.main && !saved.cleanedAt, "Expected retained fixtures from --prepare");
  const data = await dashboard(sales), own = await dashboard(first);
  metadata(findRequest(data, saved.main.firstRequestId), { round: 2, totalRounds: 2, status: "confirmed" });
  metadata(findEvent(data, saved.main.firstEventId), { result: "advanced", round: 1 });
  metadata(findEvent(data, saved.main.finalEventId), { result: "passed", round: 2 });
  metadata(findEvent(own, saved.main.entryId), { engineerConfirmedAt: saved.main.entryConfirmedAt });
  assert.equal(data.requests.filter(item => item.projectId === saved.main.projectId).length, 2);
  for (const branch of saved.branches) assert.equal(findEvent(data, branch.eventId).result, branch.outcome);
  console.log("PASS: retained interviewer/case records, round history, outcomes and entry confirmation survived backend restart.");
  process.exit(0);
}

if (process.argv.includes("--role-journey")) {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert(saved.version === 1 && saved.roleFlow?.projectId && !saved.cleanedAt, "Expected retained role-usability fixtures");
  const projectId = saved.roleFlow.projectId;
  const [salesData, leaderData, ownData] = await Promise.all([dashboard(sales), dashboard(leader), dashboard(first)]);
  const project = salesData.projects.find(item => item.id === projectId);
  assert.equal(project?.name, `${saved.prefix} 営業リーダー連携`);
  const people = salesData.requests.filter(item => item.projectId === projectId);
  assert.equal(people.length, 2, "Leader selection must produce two independent interviewer records");
  assert.equal(people.find(item => item.studentId === first)?.round, 2);
  assert.equal(people.find(item => item.studentId === first)?.status, "confirmed");
  assert.equal(people.find(item => item.studentId === second)?.round, 1);
  assert.equal(people.find(item => item.studentId === second)?.status, "requested", "The other interviewer's unanswered request must remain unchanged");
  const meetings = salesData.events.filter(item => item.projectId === projectId && item.studentId === first && !item.entry).sort((a, b) => a.round - b.round);
  assert.deepEqual(meetings.map(item => item.round), [1, 2]);
  assert.deepEqual(meetings.map(item => item.result), ["advanced", "passed"]);
  assert(meetings.every(item => item.engineerConfirmedAt), "Confirmed interview results must remain acknowledged after moving to the active project");
  assert.equal(meetings[0].url, "https://meet.example/role-journey-1");
  assert.equal(meetings[1].url, "https://meet.example/role-journey-2");
  const feedbacks = salesData.feedbacks.filter(item => item.projectId === projectId && item.studentId === first);
  assert.equal(feedbacks.length, 2);
  assert.deepEqual(new Set(feedbacks.map(item => item.eventId)), new Set(meetings.map(item => item.key)));
  assert(feedbacks.every(item => item.questions.length > 0), "Each round must retain the questions submitted through the UI");
  const entry = ownData.events.find(item => item.projectId === projectId && item.entry);
  assert(entry?.engineerConfirmedAt, "The interviewer must confirm entry completion through their own home");
  assert.equal(entry.parentEventId, meetings[1].key);
  assert.equal(leaderData.events.find(item => item.key === entry.key)?.engineerConfirmedAt, entry.engineerConfirmedAt);
  assert.equal(leaderData.requests.filter(item => item.projectId === projectId).length, 2);
  assert(ownData.events.filter(item => item.projectId === projectId).every(item => item.studentId === first));
  assert(salesData.notifications.some(item => item.kind === "lark" && item.lines?.some(line => line.label === "案件" && line.value === project.name) && item.lines.some(line => line.label === "結果" && line.value === "オファー")), "This case's offer notification preview must remain recorded");
  for (const data of [leaderData, ownData]) {
    for (const collection of ["projects", "requests", "events", "recruitments"]) {
      for (const item of data[collection]) assert.equal(item.remarks, "", "Private sales notes must not leak to the leader or interviewer");
    }
  }
  console.log("PASS: three-role UI journey; two-round history; independent interviewers; offer/entry confirmation; leader visibility and private notes.");
  process.exit(0);
}

if (process.argv.includes("--prepare")) {
  let previous;
  try { previous = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert(!previous || previous.cleanedAt, "Clean up the previous retained fixtures before preparing another run");
}

const admin = sql("SELECT id FROM app_users WHERE role='admin' ORDER BY id LIMIT 1;");
assert(admin, "An administrator is required for the management-screen verification");
const before = fingerprints();
const privateRemark = `sales-only-${randomUUID()}`;
const today = sql("SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date;");
const future = sql(`SELECT d::date FROM generate_series(:'today'::date+1, :'today'::date+365, interval '1 day') d
  WHERE NOT EXISTS (SELECT 1 FROM scheduled_events WHERE student_id IN (:'first',:'second')
    AND schedule_state='scheduled' AND (event_date BETWEEN d::date AND d::date+7 OR prep_start::date BETWEEN d::date AND d::date+7))
    AND NOT EXISTS (SELECT 1 FROM project_import_history WHERE student_id IN (:'first',:'second') AND status='joined' AND entry_date=d::date+7)
  ORDER BY d LIMIT 1;`, { today, first, second });
assert(future, "Could not find a free week for the two fixture interviewers");
function dayAfter(base, days) {
  const date = new Date(base + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function elapseEvent(eventId, projectId, studentId, kind, elapsedDay) {
  const fixture = fixtures.find(item => item.id === projectId);
  assert(fixture?.name.startsWith(prefix + " "), "Only events of this run's generated cases may be moved");
  const updated = sql(`UPDATE scheduled_events e SET event_date=:'elapsed'::date FROM projects p
    WHERE e.id=:'event' AND e.project_id=p.id AND p.id=:'project' AND p.name=(:'name'::jsonb #>> '{}') AND p.sales_id=:'sales'
      AND e.student_id=:'student' AND e.kind=:'kind' AND e.schedule_state='scheduled'
      AND e.event_date>:'today'::date AND :'elapsed'::date<:'today'::date RETURNING e.id;`,
    { event: eventId, project: projectId, name: asciiJson(fixture.name), sales, student: studentId, kind, elapsed: elapsedDay, today });
  assert.equal(updated, eventId, "Expected exactly the generated future event to have elapsed");
}
const draft = (label, overrides = {}) => ({ project: `${prefix} ${label}`, summary: "Excel workflow integration fixture.", upperCompany: "上位会社確認株式会社", primeCompany: "元請け確認株式会社", endCompany: "エンド確認株式会社", category: "Java", remarks: privateRemark, participantName: "参画者確認用", participantNameKana: "さんかくしゃかくにんよう", assignmentMode: "direct", studentIds: [first], leaderId: leader, scheduleMode: "candidates", candidates: [{ start: future+"T13:00", end: future+"T14:00" }], totalRounds: 1, ...overrides });
const create = (label, overrides) => request(sales, "/api/requests", draft(label, overrides), [200, 201]);
const result = (user, eventId, value, expected = 200) => request(user, `/api/events/${eventId}/result`, { result: value }, expected);
const feedback = (user, eventId) => request(user, `/api/events/${eventId}/feedback`, { duties: "API開発", process: "設計・実装", remote: "週2日", impression: "面談回数ごとの履歴を確認しました。", questions: [`Round verification question ${eventId}`] });

async function confirmRequest(user, requestId) {
  const saved = findRequest(await dashboard(sales), requestId);
  const slotId = saved.candidates[0].id;
  await request(user, `/api/requests/${requestId}/respond`, { slotIds: [slotId] });
  const confirmed = await request(sales, `/api/requests/${requestId}/confirm`, { slotId, url: `https://meet.example/excel-${requestId}-${saved.round}` });
  assert(confirmed.eventId, "Confirmation did not return an event identity");
  return { eventId: confirmed.eventId, slotId };
}

function metadata(record, expected) {
  assert(record, "New-field-bearing record missing");
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, `${key} did not match the stored metadata`);
}

let completed = false;
const state = { version: 1, prefix, fixtures, createdAt: new Date().toISOString() };
try {
  await request(sales, "/api/admin/projects", undefined, 403, { "X-DealHunter-Role": "admin" });
  await request(leader, "/api/admin/projects", undefined, 403);
  await request(first, "/api/admin/projects", undefined, 403);
  await request(admin, "/api/admin/projects", undefined, 401, { "X-DealHunter-Key": "" });
  await request(sales, "/api/requests", draft("invalid rounds", { totalRounds: 0 }), 400);

  const created = await create("multiple interviewers 日本語案件 🔔", { studentIds: [first, second], totalRounds: 2 });
  let salesData = await dashboard(sales);
  const project = salesData.projects.find(item => item.id === created.projectId);
  metadata(project, { primeCompany: "元請け確認株式会社", category: "Java", remarks: privateRemark, executorName: "", followerNames: [] });
  const initialRequests = salesData.requests.filter(item => item.projectId === created.projectId);
  assert.equal(initialRequests.length, 2, "A separate interviewer record is required for each selected person");
  assert.equal(new Set(initialRequests.map(item => item.studentId)).size, 2);
  const firstRequest = initialRequests.find(item => item.studentId === first);
  const secondRequest = initialRequests.find(item => item.studentId === second);
  assert(firstRequest && secondRequest);
  for (const record of initialRequests) metadata(record, { round: 1, totalRounds: 2, primeCompany: "元請け確認株式会社", category: "Java", remarks: privateRemark });
  for (const user of [first, second, leader]) {
    const visible = await dashboard(user);
    assert(!JSON.stringify(visible).includes(privateRemark), "Sales-only remarks leaked to another role");
  }
  assert(!(await dashboard(outsider)).projects.some(item => item.id === created.projectId), "Unrelated student received a private project");

  const update = { executorName: "実務担当確認用", followerNames: ["フォロー担当A", "フォロー担当B"], primeCompany: "管理者更新元請け", category: ".NET", remarks: privateRemark + "-updated" };
  await request(sales, `/api/admin/projects/${created.projectId}`, update, 403);
  await request(leader, `/api/admin/projects/${created.projectId}`, update, 403);
  await request(first, `/api/admin/projects/${created.projectId}`, update, 403);
  await request(admin, `/api/admin/projects/${created.projectId}`, { leaderId: "leader-suzuki" }, 400);
  await request(admin, `/api/admin/projects/${created.projectId}`, { followerNames: "one person" }, 400);
  await request(admin, `/api/admin/projects/${created.projectId}`, { ...update, revision: 1 });
  await request(admin, `/api/admin/projects/${created.projectId}`, { revision: 1, executorName: "競合時は保存しない" }, 409);
  await request(admin, `/api/admin/projects/${created.projectId}`, { revision: 2, upperCompany: "" }, 400);
  metadata((await request(admin, "/api/admin/projects")).projects.find(item => item.id === created.projectId), update);
  for (const user of [sales, first, second, leader]) {
    const visible = await dashboard(user);
    const expected = { ...update, remarks: user === sales ? update.remarks : "" };
    metadata(visible.projects.find(item => item.id === created.projectId), expected);
    for (const record of visible.requests.filter(item => item.projectId === created.projectId)) metadata(record, expected);
    if (user !== sales) assert(!JSON.stringify(visible).includes(update.remarks), "Updated private remarks leaked through a nested record");
  }

  await request(second, `/api/requests/${firstRequest.id}/respond`, { slotIds: [firstRequest.candidates[0].id] }, 403);
  const firstRound = await confirmRequest(first, firstRequest.id);
  const secondPersonRound = await confirmRequest(second, secondRequest.id);
  elapseEvent(firstRound.eventId, created.projectId, first, "meet", dayAfter(today, -6));
  await feedback(first, firstRound.eventId);
  const roundTwo = dayAfter(future, 1);
  const nextBody = { scheduleMode: "candidates", candidates: [{ start: roundTwo+"T14:00", end: roundTwo+"T15:00" }], totalRounds: 2 };
  await request(second, `/api/events/${firstRound.eventId}/next-round`, nextBody, 403);
  await request(sales, `/api/events/${firstRound.eventId}/next-round`, { ...nextBody, totalRounds: 1 }, 400);
  await request(sales, `/api/events/${firstRound.eventId}/next-round`, nextBody);
  await request(sales, `/api/events/${firstRound.eventId}/next-round`, nextBody, 409);
  await result(sales, firstRound.eventId, "offered", 409);
  salesData = await dashboard(sales);
  metadata(findEvent(salesData, firstRound.eventId), { result: "advanced", round: 1, totalRounds: 2 });
  const reopened = findRequest(salesData, firstRequest.id);
  metadata(reopened, { status: "requested", round: 2, totalRounds: 2 });
  assert(!reopened.candidates.some(item => item.id === firstRound.slotId), "A previous round's candidates leaked into the current response");
  metadata(findRequest(salesData, secondRequest.id), { status: "confirmed", round: 1, totalRounds: 2 });
  metadata(findEvent(salesData, secondPersonRound.eventId), { result: "pending", round: 1 });
  await acknowledge(first, firstRound.eventId);
  assert.equal(findRequest(await dashboard(first), firstRequest.id).status, "requested", "Acknowledging the previous result closed the new interview round");
  await request(first, `/api/requests/${firstRequest.id}/respond`, { slotIds: [firstRound.slotId] }, 400);
  const finalRound = await confirmRequest(first, firstRequest.id);
  assert.notEqual(finalRound.eventId, firstRound.eventId);
  salesData = await dashboard(sales);
  assert.equal(salesData.requests.filter(item => item.projectId === created.projectId && item.studentId === first).length, 1, "The next round duplicated the interviewer/case record");
  assert.equal(salesData.events.filter(item => item.requestId === firstRequest.id && item.type === "meet").length, 2, "Both interview rounds must remain in history");
  metadata(findEvent(salesData, finalRound.eventId), { round: 2, totalRounds: 2 });
  assert(!(await dashboard(second)).events.some(item => item.key === firstRound.eventId || item.key === finalRound.eventId), "A second interviewer received another interviewer's round history");
  assert(!(await dashboard(first)).events.some(item => item.key === secondPersonRound.eventId), "The first interviewer received the other interviewer's event");
  elapseEvent(finalRound.eventId, created.projectId, first, "meet", dayAfter(today, -3));
  await feedback(first, finalRound.eventId);
  await result(first, finalRound.eventId, "offered", 403);
  await result(sales, finalRound.eventId, "offered");
  assert.equal(findEvent(await dashboard(first), finalRound.eventId).result, "offered");
  assert(!(await dashboard(sales)).events.some(item => item.requestId === firstRequest.id && item.entry), "An offer alone created an entry event");
  await acknowledge(first, finalRound.eventId);
  const entryBody = { result: "passed", when: dayAfter(future, 7)+"T09:00", where: "統合確認受付", memo: "入場完了は面談者が確認します。" };
  await request(second, `/api/events/${finalRound.eventId}/entry`, entryBody, 403);
  const entry = await request(sales, `/api/events/${finalRound.eventId}/entry`, entryBody);
  await request(sales, `/api/events/${finalRound.eventId}/entry`, entryBody, 409);
  salesData = await dashboard(sales);
  assert.equal(entry.preview.lines.find(line => line.label === "面談者")?.value, firstRequest.person);
  assert.equal(entry.preview.lines.find(line => line.label === "参画者")?.value, salesData.projects.find(item => item.id === created.projectId).participantName || "未登録");
  assert(!entry.preview.lines.some(line => line.label === "入場者"), "The interviewer must not be mislabeled as the person entering the project");
  metadata(findEvent(salesData, finalRound.eventId), { result: "passed", engineerConfirmedAt: null });
  metadata(findEvent(salesData, entry.eventId), { studentId: first, parentEventId: finalRound.eventId, engineerConfirmedAt: null });
  await acknowledge(second, entry.eventId, 403);
  await acknowledge(leader, entry.eventId, 403);
  await acknowledge(first, entry.eventId, 409);
  elapseEvent(entry.eventId, created.projectId, first, "entry", dayAfter(today, -1));
  const acknowledged = await acknowledge(first, entry.eventId);
  assert(acknowledged.engineerConfirmedAt, "First entry acknowledgement was not persisted");
  const repeated = await acknowledge(first, entry.eventId);
  assert.equal(repeated.engineerConfirmedAt, acknowledged.engineerConfirmedAt, "Repeated confirmation changed the completed entry timestamp");
  metadata(findEvent(await dashboard(first), entry.eventId), { engineerConfirmedAt: acknowledged.engineerConfirmedAt, executorName: update.executorName, followerNames: update.followerNames });

  const branches = [];
  for (const outcome of ["declined", "rejected"]) {
    const branch = await create(outcome);
    const branchRequest = (await dashboard(sales)).requests.find(item => item.projectId === branch.projectId);
    const meeting = await confirmRequest(first, branchRequest.id);
    elapseEvent(meeting.eventId, branch.projectId, first, "meet", dayAfter(today, outcome === "declined" ? -5 : -4));
    await feedback(first, meeting.eventId);
    if (outcome === "declined") await result(sales, meeting.eventId, "offered");
    await result(sales, meeting.eventId, outcome);
    const data = await dashboard(sales);
    metadata(findEvent(data, meeting.eventId), { result: outcome });
    assert(!data.events.some(item => item.projectId === branch.projectId && item.entry), "A declined/rejected case created a first entry");
    await request(sales, `/api/events/${meeting.eventId}/entry`, entryBody, 409);
    await request(sales, `/api/events/${meeting.eventId}/next-round`, nextBody, 409);
    await acknowledge(first, meeting.eventId);
    branches.push({ outcome, projectId: branch.projectId, requestId: branchRequest.id, eventId: meeting.eventId });
  }
  Object.assign(state, { main: { projectId: created.projectId, firstRequestId: firstRequest.id, secondRequestId: secondRequest.id, firstEventId: firstRound.eventId, finalEventId: finalRound.eventId, entryId: entry.eventId, entryConfirmedAt: acknowledged.engineerConfirmedAt }, branches });
  if (process.argv.includes("--prepare")) {
    const uiRunId = randomUUID();
    const uiAdmin = { name: `Excel UI verification ${uiRunId}`, email: `ui-excel.${uiRunId}@legarea.jp`, password: "Excel-Ui-Only-2026!" };
    const invitation = await request(admin, "/api/admin/users", { purpose: "invite", email: uiAdmin.email, role: "student" });
    const registered = await request("", "/api/auth/register", { ...uiAdmin, role: "student", code: invitation.code }, [200, 201]);
    assert(registered.user?.id, "Temporary UI account registration failed");
    await request(admin, `/api/admin/users/${registered.user.id}`, { role: "admin", leaderId: null });
    const login = await request("", "/api/auth/login", { email: uiAdmin.email, password: uiAdmin.password });
    assert.equal(login.user?.role, "admin", "Temporary UI account could not authenticate as an administrator");
    state.uiAdmin = { ...uiAdmin, id: registered.user.id };
  }
  completed = true;
  console.log("PASS: Excel metadata; admin-only later assignment; private remarks; interviewer/case isolation; round 1→2 history; offer/decline/rejection; interviewer entry confirmation; duplicate and ownership guards.");
} finally {
  if (completed && process.argv.includes("--prepare")) {
    await writeFile(statePath, JSON.stringify({ ...state, fixtures, generatedUsers, preparedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    console.log("Fixtures retained for browser/restart verification. Run node backend/verify-excel-workflow.mjs --cleanup to remove only these generated cases.");
  } else {
    cleanup(fixtures, generatedUsers);
    assert.deepEqual(fingerprints(), before, "Existing database records changed outside the generated fixtures");
    console.log("PASS: exact generated fixture cleanup; all original users and business records preserved, with no fixed account-count assumption.");
  }
}
