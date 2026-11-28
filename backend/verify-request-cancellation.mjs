import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

// Use only the disposable stack created by verify-end-companies.ps1 -RequestCancellation.
const root = process.env.DEALHUNTER_END_TEST_ROOT;
const database = "dealhunter_end_companies_test";
assert(root);
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), database);
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert(manifest.testRoot === root && manifest.apiPort !== 8080 && ![15432, 55432].includes(manifest.postgresPort));
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();

function sql(input, variables = []) {
  const result = spawnSync(path.join(manifest.postgresBin, "psql.exe"), [
    "-XqAt", "-h", "127.0.0.1", "-p", String(manifest.postgresPort), "-U", "dealhunter",
    "-d", database, "-v", "ON_ERROR_STOP=1", ...variables, "-f", "-",
  ], { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function notices() {
  return JSON.parse(sql("SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY id),'[]') FROM lark_cancellation_notifications n;"));
}
async function request(actor, endpoint, body, statuses = [200]) {
  const response = await fetch("http://127.0.0.1:" + manifest.apiPort + "/api/" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-DealHunter-Key": key,
      ...(actor ? { "X-DealHunter-User": actor } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert(statuses.includes(response.status), `${endpoint}: ${response.status} ${data.error ?? ""}`);
  return { status: response.status, data };
}

const sales = "sales-aoki", first = "student-takahashi", second = "student-yamamoto", leader = "leader-sato";
const directName = "取り消しテスト・個人依頼";
const recruitmentName = "取り消しテスト・リーダー依頼";

if (process.argv.includes("--persisted")) {
  async function waitFor(condition) {
    for (let attempt = 0; attempt < 48; attempt++) {
      const row = notices().find(condition);
      if (row) return row;
      await setTimeout(500);
    }
    assert.fail("Lark outbox did not reach the expected state");
  }
  const direct = await waitFor(row => row.recipient_id === first && row.message.includes(directName) && row.sent_at);
  const pendingLeader = await waitFor(row => row.recipient_id === leader && row.message.includes(recruitmentName) && row.attempts > 0);
  assert.equal(pendingLeader.sent_at, null, "Unknown recipients are left for retry");
  assert.equal(notices().filter(row => row.recipient_id === first && row.message.includes(directName)).length, 1);
  assert(!((await request(sales, "dashboard")).data.requests.some(row => row.project === directName && row.studentId === first)));
  sql("UPDATE app_users SET email='unmapped@example.test' WHERE id='student-takahashi'; UPDATE app_users SET email='takahashi@example.test' WHERE id='leader-sato';");
  assert.match(pendingLeader.id, /^[0-9a-f-]+$/);
  sql(`UPDATE lark_cancellation_notifications SET next_attempt_at=now() WHERE id='${pendingLeader.id}';`);
  const retried = await waitFor(row => row.id === pendingLeader.id && row.sent_at);
  assert(retried.attempts > pendingLeader.attempts);
  assert.equal(notices().find(row => row.id === direct.id).attempts, 1, "Successfully delivered notifications must not be retried");
  console.log("PASS: cancellation remains hidden after restart, queued Lark notification is sent by the worker, failed address is retried using the same ID");
  process.exit(0);
}

const dashboard = async actor => (await request(actor, "dashboard")).data;
const paths = id => "requests/" + id + "/";
const upcoming = days => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) + "T14:00";
const create = async (project, options = {}) => (await request(sales, "requests", {
  project, summary: "通知に含めない案件の備考", upperCompany: "テスト上位会社", leaderId: leader,
  studentIds: [first, second], scheduleMode: "candidates", candidates: [{ start: upcoming(14) }], ...options,
})).data;
const pending = async id => (await dashboard(sales)).requests.find(row => row.id === id);
async function answer(actor, id) {
  const row = await pending(id);
  await request(actor, paths(id) + "respond", { revision: row.taskRevision, slotIds: [row.candidates[0].id] });
  return pending(id);
}
const cancel = (actor, row, statuses = [200]) => request(actor, paths(row.id) + "cancel", { revision: row.taskRevision }, statuses);
const { data: { code } } = await request("admin-initial", "admin/users", { purpose: "invite", email: "request-cancellation-sales@legarea.jp", role: "sales" });
const { data: { user: { id: otherSales } } } = await request(null, "auth/register", {
  code, name: "別担当営業", email: "request-cancellation-sales@legarea.jp", password: randomUUID(), role: "sales",
});
assert.equal(notices().length, 0);
const grouped = await create(directName, {
  attachment: { name: "sample.pdf", contentBase64: Buffer.from("fixture skill sheet").toString("base64") },
});
const pendingFirst = (await dashboard(sales)).requests.find(row => row.projectId === grouped.projectId && row.studentId === first);
const pendingSecond = (await dashboard(sales)).requests.find(row => row.projectId === grouped.projectId && row.studentId === second);
const answered = await answer(first, pendingFirst.id);
assert((await dashboard(sales)).tasks.some(task => task.requestId === answered.id));
for (const actor of [otherSales, first, leader]) await cancel(actor, answered, [403]);
await cancel(sales, pendingFirst, [409]);
await request(sales, paths(answered.id) + "cancel", {}, [400]);
assert.equal(notices().length, 0, "Rejected cancellation must never enqueue a message");
assert.equal((await cancel(sales, answered)).data.notificationStatus, "notConfigured");
for (const actor of [sales, first, leader]) assert(!(await dashboard(actor)).requests.some(row => row.id === answered.id));
assert(!(await dashboard(sales)).tasks.some(task => task.requestId === answered.id));
assert(!(await dashboard(first)).projects.some(row => row.id === grouped.projectId));
assert((await dashboard(second)).requests.some(row => row.id === pendingSecond.id));
await request(first, paths(answered.id) + "attachment", undefined, [404]);
await request(first, paths(answered.id) + "respond", {}, [404]);
await cancel(sales, answered, [404]);
assert.deepEqual(notices().map(row => row.recipient_id), [first]);
assert(notices()[0].message.includes(directName) && !notices()[0].message.includes("通知に含めない案件の備考"));

const secondAnswered = await answer(second, pendingSecond.id);
const simultaneous = await Promise.all([
  cancel(sales, secondAnswered, [200, 409]),
  request(sales, paths(secondAnswered.id) + "confirm", { revision: secondAnswered.taskRevision, slotId: secondAnswered.candidates[0].id }, [200,404]),
]);
assert.equal(simultaneous.filter(result => result.status === 200).length, 1, "A request must not be confirmed and cancelled concurrently");
const previous = await create("取り消しテスト・二次面談", {
  studentIds: [first], totalRounds: 2, candidates: [{ start: upcoming(7) }],
});
const firstRound = await answer(first, previous.requestId);
const { data: { eventId } } = await request(sales, paths(firstRound.id) + "confirm", { revision:firstRound.taskRevision, slotId: firstRound.candidates[0].id });
await cancel(sales, await pending(firstRound.id), [409]);
sql("UPDATE scheduled_events SET event_date=CURRENT_DATE-1 WHERE id=:'event';", ["-v", "event=" + eventId]);
await request(sales, "events/" + eventId + "/next-round", { scheduleMode: "availability" });
const nextRound = await pending(firstRound.id);
assert.equal(nextRound.round, 2);
await cancel(sales, nextRound);
assert((await request(sales, "engineer-interview-history/" + first)).data.interviews.some(row => row.id === "event:" + eventId));

const { recruitmentId } = await create(recruitmentName, { assignmentMode: "leader", studentIds: [] });
const recruitment = "recruitments/" + recruitmentId + "/";
await request(otherSales, recruitment + "cancel", {}, [403]);
await request(leader, recruitment + "cancel", {}, [403]);
await request(sales, recruitment + "cancel", {});
assert(!(await dashboard(leader)).recruitments.some(row => row.id === recruitmentId));
assert(!(await dashboard(sales)).tasks.some(task => task.recruitmentId === recruitmentId));
await request(leader, recruitment + "assign", { studentIds: [first] }, [404]);
const competing = await create("取り消しテスト・同時選定", { assignmentMode: "leader", studentIds: [] });
const competingPath = "recruitments/" + competing.recruitmentId + "/";
const assignmentRace = await Promise.all([
  request(sales, competingPath + "cancel", {}, [200,409]),
  request(leader, competingPath + "assign", { studentIds:[first] }, [200,404]),
]);
assert.equal(assignmentRace.filter(result => result.status === 200).length, 1, "Selection and cancellation must be mutually exclusive");
assert(notices().every(row => row.attempts === 0 && row.sent_at === null), "Disabled integration preserves unsent messages");
assert.deepEqual(notices().filter(row => row.message.includes(recruitmentName)).map(row => row.recipient_id), [leader]);
sql("UPDATE app_users SET email='takahashi@example.test' WHERE id='student-takahashi';");
console.log("PASS: cancellation ownership, versions, scheduled/assigned races, list and task removal, per-recipient messages, and past interview history");
