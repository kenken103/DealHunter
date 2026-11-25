import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, ".local/notice-workflow-fixtures.json");
const saveFixtures = process.argv.includes("--prepare");
const secret = (await readFile(join(root, ".local/api-key"), "utf8")).trim();
const pgPassword = (await readFile(join(root, ".local/database.password"), "utf8")).trim();
const sales = "sales-aoki", leader = "leader-sato", people = ["student-takahashi", "student-yamamoto"];
const run = randomUUID();
const fixtures = [];
const state = { run, fixtures };
const api = "http://127.0.0.1:8080/api";
const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const t = hhmm => day + "T" + hhmm;

function sql(query, vars = {}) {
  const binary = process.env.DEALHUNTER_POSTGRES_BIN ? join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "15432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [key, value] of Object.entries(vars)) args.push("-v", key + "=" + value);
  const r = spawnSync(binary, [...args, "-f", "-"], { cwd: root, input: query, encoding: "utf8", windowsHide: true, timeout: 20000,
    env: { ...process.env, PGPASSWORD: pgPassword, PGCLIENTENCODING: "UTF8" } });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr);
  return r.stdout.trim();
}

// Verify the named cluster before allowing test creates or cleanup. Fixture IDs and names must match together.
assert.equal(resolve(sql("SELECT current_setting('data_directory');")).toLowerCase(),
  resolve(root, ".local/postgres").toLowerCase(), "Refusing mutation in a different PostgreSQL cluster");
function cleanup(data) {
  assert(/^[a-f0-9-]{36}$/.test(data.run) && Array.isArray(data.fixtures), "Invalid fixture manifest");
  if (!data.fixtures.length) return;
  for (const f of data.fixtures) {
    assert(/^DH-[a-f0-9-]{36}$/.test(f.id));
    assert(["schedule", "pending-group"].includes(f.tag));
    assert.equal(f.name, "Notice QA " + data.run + " " + f.tag);
  }
  sql(`BEGIN;
CREATE TEMP TABLE targets ON COMMIT DROP AS SELECT p.id FROM projects p
JOIN jsonb_to_recordset(:'fixtures'::jsonb) f(id text,name text) ON p.id=f.id AND p.name=f.name WHERE p.sales_id='sales-aoki';
SELECT 1/(CASE WHEN count(*)=:'count'::int THEN 1 ELSE 0 END) FROM targets;
DELETE FROM task_acknowledgements WHERE project_id IN (SELECT id FROM targets);
DELETE FROM notification_previews WHERE project_id IN (SELECT id FROM targets);
DELETE FROM interview_questions WHERE project_id IN (SELECT id FROM targets);
DELETE FROM interview_feedback WHERE event_id IN (SELECT id FROM scheduled_events WHERE project_id IN (SELECT id FROM targets));
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM targets) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM targets);
DELETE FROM candidate_slots WHERE request_id IN (SELECT id FROM interview_requests WHERE project_id IN (SELECT id FROM targets));
DELETE FROM interview_requests WHERE project_id IN (SELECT id FROM targets);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM targets);
DELETE FROM projects WHERE id IN (SELECT id FROM targets);
COMMIT;`, { fixtures: JSON.stringify(data.fixtures), count: data.fixtures.length });
}
if (process.argv.includes("--cleanup")) {
  const data = JSON.parse(await readFile(manifest, "utf8"));
  cleanup(data);
  await unlink(manifest);
  console.log("PASS: cleaned the identified notice fixtures.");
  process.exit(0);
}
if (saveFixtures) await writeFile(manifest, JSON.stringify(state), { flag: "wx" });

async function request(who, path, body, expected = [200]) {
  const response = await fetch(api + path, { method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": secret, "X-DealHunter-User": who, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert(expected.includes(response.status), path + " returned " + response.status + " " + (data.error || ""));
  return data;
}
const dash = who => request(who, "/dashboard");
async function reqRecord(id) { return (await dash(sales)).requests.find(r => r.id === id); }
async function event(who, id) {
  const e = (await dash(who)).events.find(e => e.key === id);
  assert(e, "Fixture event missing from its owner's dashboard"); return e;
}
async function createGroup(tag) {
  const name = "Notice QA " + run + " " + tag;
  const result = await request(sales, "/requests", { project: name, summary: "参加案内の確認用", upperCompany: "検証用取引先",
    studentIds: people, assignmentMode: "direct", leaderId: leader, scheduleMode: "candidates", candidates: [{ start: t("18:00") }] }, [200, 201]);
  assert.match(result.projectId, /^DH-[a-f0-9-]{36}$/);
  fixtures.push({ id: result.projectId, name, tag });
  if (saveFixtures) await writeFile(manifest, JSON.stringify(state));
  const requests = (await dash(sales)).requests.filter(r => r.projectId === result.projectId);
  assert.equal(requests.length, 2);
  return { id: result.projectId, requests, ids: requests.map(r => r.id) };
}
const respond = (r, payload) => request(r.studentId, "/requests/" + r.id + "/respond", payload);
const groupConfirm = (ids, payload, expected = [200]) => request(sales, "/requests/group-confirm", { requestIds: ids, ...payload }, expected);
const notice = (id, revision, fields, expected = [200]) => request(sales, "/events/" + id + "/notice", { revision, ...fields }, expected);
const read = (who, id, revision, expected = [200]) => request(who, "/events/" + id + "/notice-read", { revision }, expected);

let complete = false;
try {
  const scheduled = await createGroup("schedule");
  const [earlier, later] = [...scheduled.requests].sort((a,b) => a.id < b.id ? -1 : 1);
  await respond(earlier, { responseKind: "unavailable", responseNote: "全候補不可です" });
  assert.equal((await reqRecord(earlier.id)).responseKind, "unavailable");
  await request(sales, "/requests/" + earlier.id + "/reopen", { candidates: [{ start: t("19:30") }] });
  const reopened = await reqRecord(earlier.id);
  assert.equal(reopened.status, "requested");
  assert.equal(reopened.responseKind, "none");
  assert.equal(reopened.candidates.length, 1);
  assert(Number.isInteger(reopened.taskRevision) && reopened.taskRevision > earlier.taskRevision);
  await request(earlier.studentId, "/requests/" + earlier.id + "/respond",
    { responseKind: "unavailable", revision: earlier.taskRevision }, [409]);
  assert.equal((await reqRecord(earlier.id)).status, "requested");
  const alternatives = [{ start: t("14:00"), end: t("16:30") }, { start: t("17:00"), openEnded: true }];
  await respond(earlier, { responseKind: "alternative", revision: reopened.taskRevision, proposals: alternatives, responseNote: "早い枠を希望" });
  const answer = await reqRecord(earlier.id);
  assert.equal(answer.responseKind, "alternative");
  assert.equal(answer.responseNote, "早い枠を希望");
  assert(answer.candidates.some(s => s.proposed && s.end === t("16:30")));
  assert(answer.candidates.some(s => s.proposed && s.openEnded && s.start === t("17:00")));
  await respond(later, { slotIds: [later.candidates[0].id] });
  // The first request in the server's sorted lock order accepts 15:30, the second rejects it.
  await groupConfirm(scheduled.ids, { start: t("15:30") }, [400]);
  const untouched = await dash(sales);
  assert(!untouched.events.some(e => e.projectId === scheduled.id));
  assert(untouched.requests.filter(r => r.projectId === scheduled.id).every(r => r.status === "responded"));
  await respond(later, { responseKind: "alternative", proposals: [{ start: t("15:00"), end: t("16:00") }] });
  const current = (await dash(sales)).requests.filter(r => r.projectId === scheduled.id);
  const revisions = Object.fromEntries(current.map(r => [r.id, r.taskRevision]));
  await groupConfirm(scheduled.ids, { start: t("15:30"), revisions: { ...revisions, [later.id]: later.taskRevision } }, [409]);
  const afterConflict = await dash(sales);
  assert(!afterConflict.events.some(e => e.projectId === scheduled.id));
  assert.deepEqual(afterConflict.requests.filter(r => r.projectId === scheduled.id), current);
  const confirmed = await groupConfirm(scheduled.ids, { revisions, start: t("15:30"), end: t("16:00"), prepStart: t("14:30"),
    prepUrl: "https://example.com/briefing", meetingId: "テスト会議", passcode: "test-only", emergencyContact: "検証用窓口",
    instructions: "開始3分前に接続してください", clientFeedback: "private-fixture-" + run, shareFeedback: false });
  assert.equal(confirmed.eventIds.length, 2);
  const visible = (await dash(sales)).events.filter(e => e.projectId === scheduled.id);
  assert.equal(visible.length, 2);
  const mine = visible.find(e => e.studentId === people[0]), other = visible.find(e => e.studentId === people[1]);
  assert.equal(mine.url, "");
  assert.equal(mine.time, "15:30");
  assert.equal(mine.prepStart, t("14:30"));
  assert(mine.clientFeedback.includes(run));
  assert((await dash(sales)).tasks.some(x => x.eventId === mine.key && x.action === "notice" && x.title === "本面談URLを登録"), "Identify the missing main URL");
  for (const who of [people[0], leader]) assert.equal((await event(who, mine.key)).clientFeedback, "");
  assert(!(await dash(people[1])).events.some(e => e.key === mine.key));
  await read(people[1], mine.key, mine.noticeRevision, [403,404]);
  await read(people[0], mine.key, mine.noticeRevision);
  const acknowledged = await event(people[0], mine.key);
  assert(acknowledged.noticeReadAt);
  const privateEdit = await notice(mine.key, mine.noticeRevision, { clientFeedback: "private-edit-" + run });
  assert.equal(privateEdit.preview, undefined);
  assert.equal((await event(sales, mine.key)).clientFeedback, "private-edit-" + run);
  const unchanged = await event(people[0], mine.key);
  assert.equal(unchanged.clientFeedback, "");
  assert.equal(unchanged.noticeReadAt, acknowledged.noticeReadAt);
  assert.deepEqual(unchanged.changes, acknowledged.changes);
  const updates = await notice(mine.key, privateEdit.revision, { url: "https://example.com/main", shareFeedback: true, clientFeedback: "次回は設計経験を説明" });
  await read(people[0], mine.key, mine.noticeRevision, [409]);
  await notice(mine.key, mine.noticeRevision, { instructions: "obsolete" }, [409]);
  const changed = await event(people[0], mine.key);
  assert.equal(changed.noticeRevision, updates.revision);
  assert.equal(changed.noticeReadAt, null);
  assert.equal(changed.clientFeedback, "次回は設計経験を説明");
  assert.equal(changed.emergencyContact, "検証用窓口");
  assert.equal(changed.url, "https://example.com/main");
  assert.equal(changed.prepUrl, "https://example.com/briefing");
  assert(changed.changes.some(c => c.revision === updates.revision));
  assert(!(await dash(sales)).tasks.some(x => x.eventId === mine.key && x.action === "notice"));
  const prepOnly = await notice(other.key, other.noticeRevision, { url: "https://example.com/old-main", prepUrl: "" });
  assert((await dash(sales)).tasks.some(x => x.eventId === other.key && x.title === "事前打合せURLを登録"), "Identify the missing prep URL");
  const paused = await notice(other.key, prepOnly.revision, { scheduleState: "postponed", reason: "先方の延期" });
  assert.equal((await event(leader, other.key)).scheduleState, "postponed");
  await request(other.studentId, "/events/" + other.key + "/feedback", { duties: "開発", process: "設計", remote: "週2", impression: "テスト", questions: [] }, [409]);
  await request(sales, "/events/" + other.key + "/result", { result: "rejected" }, [409]);
  const resumed = await notice(other.key, paused.revision, { scheduleState: "scheduled", start: t("16:30"), end: t("17:00"), reason: "新日程" });
  const revisedPlan = await event(other.studentId, other.key);
  assert.equal(revisedPlan.time, "16:30");
  for (const key of ["url", "prepUrl", "meetingId", "passcode"]) assert.equal(revisedPlan[key], "", "Clear expired " + key);
  assert.equal(revisedPlan.prepStart, null);
  assert.equal(revisedPlan.prepUrl, "");
  for (const revision of [other.noticeRevision, paused.revision]) {
    const prior = revisedPlan.changes.find(change => change.revision === revision);
    assert(prior);
    assert.equal(prior.start, t("15:30"));
    assert.equal(prior.end, t("16:00"));
    assert.equal(prior.prepStart, t("14:30"));
  }
  const updatedPlan = revisedPlan.changes.find(change => change.revision === resumed.revision);
  assert.equal(updatedPlan.start, t("16:30"));
  assert.equal(updatedPlan.end, t("17:00"));
  assert.equal(updatedPlan.prepStart, null);
  const cancelled = await notice(other.key, resumed.revision, { scheduleState: "cancelled", reason: "先方による中止" });
  assert.equal((await event(other.studentId, other.key)).scheduleState, "cancelled");
  await notice(other.key, cancelled.revision, { scheduleState: "scheduled", start: t("15:45") }, [409]);
  await request(sales, "/events/" + other.key + "/entry", { result: "rejected" }, [409]);
  await read(other.studentId, other.key, cancelled.revision);
  assert((await event(sales, other.key)).noticeReadAt);
  if (saveFixtures) {
    const pending = await createGroup("pending-group");
    for (const r of pending.requests) await respond(r, { slotIds: [r.candidates[0].id] });
    Object.assign(state, { scheduledProjectId: scheduled.id, engineerEventId: mine.key, withdrawnEventId: other.key, pendingProjectId: pending.id,
      pendingRequestIds: pending.ids, commonStart: t("18:00") });
    await writeFile(manifest, JSON.stringify(state, null, 2) + "\n");
  } else {
    // Browser fixtures keep the interview upcoming. A normal verification follows it through closure.
    const eventPath = "/events/" + mine.key;
    await request(mine.studentId, eventPath + "/feedback", { duties: "開発", process: "設計", remote: "週2", impression: "事例を説明できました", questions: [] });
    await request(sales, eventPath + "/result", { result: "rejected" });
    await request(mine.studentId, eventPath + "/acknowledge", {});
    const archived = await event(mine.studentId, mine.key);
    assert(archived.engineerConfirmedAt);
    assert.equal(archived.result, "rejected");
    const hideEvaluation = await notice(mine.key, archived.noticeRevision, { shareFeedback: false });
    await read(mine.studentId, mine.key, hideEvaluation.revision);
    await notice(mine.key, hideEvaluation.revision, { start: t("16:00"), reason: "変更不可の検証" }, [409]);
    const instructions = "次回までに設計判断の具体例を準備してください";
    const privateAssessment = "private-after-result-" + run;
    const followup = await notice(mine.key, hideEvaluation.revision, { instructions, clientFeedback: privateAssessment, shareFeedback: false });
    const engineerRecord = await event(mine.studentId, mine.key);
    assert.equal(engineerRecord.instructions, instructions);
    assert.equal(engineerRecord.clientFeedback, "");
    assert.equal(engineerRecord.shareFeedback, false);
    assert.equal(engineerRecord.time, archived.time);
    assert.equal(engineerRecord.engineerConfirmedAt, archived.engineerConfirmedAt);
    assert.equal(engineerRecord.noticeRevision, followup.revision);
    assert.equal(engineerRecord.noticeReadAt, null);
    assert(engineerRecord.changes.some(change => change.revision === followup.revision));
    assert(!JSON.stringify(await dash(mine.studentId)).includes(privateAssessment));
    assert.equal((await event(sales, mine.key)).clientFeedback, privateAssessment);
    await read(mine.studentId, mine.key, hideEvaluation.revision, [409]);
    await read(mine.studentId, mine.key, followup.revision);
    assert((await event(sales, mine.key)).noticeReadAt);
    console.log("PASS: archived interview retains its acknowledged result and time, private assessment stays private, and revised preparation can be read.");
  }
  complete = true;
  console.log("PASS: availability/reopen, group overlap and atomic rollback, separate briefing/main, URL follow-up, privacy, ownership, stale revisions, withdrawal guards.");
} finally {
  if (!saveFixtures || !complete) {
    cleanup(state);
    if (saveFixtures) await unlink(manifest);
  } else console.log("Browser fixtures ready: .local/notice-workflow-fixtures.json. Clean using node backend/verify-notices.mjs --cleanup.");
}
