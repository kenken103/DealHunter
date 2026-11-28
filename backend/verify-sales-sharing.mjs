import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Only the disposable PostgreSQL/Java stack from -SalesSharing is accepted.
const root = process.env.DEALHUNTER_END_TEST_ROOT;
assert(root);
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert(manifest.apiPort && manifest.apiPort !== 8080 && manifest.postgresPort && ![15432, 55432].includes(manifest.postgresPort));
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();

function send(actor, endpoint, body) {
  const headers = { "X-DealHunter-Key": key, "Content-Type": "application/json" };
  if (actor) headers["X-DealHunter-User"] = actor;
  return fetch("http://127.0.0.1:" + manifest.apiPort + "/api/" + endpoint, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
}
async function call(actor, endpoint, body, status = 200) {
  const response = await send(actor, endpoint, body);
  const data = await response.json();
  assert.equal(response.status, status, endpoint + " " + (data.error ?? ""));
  return data;
}
const dashboard = actor => call(actor, "dashboard");
const sales = "sales-aoki", student = "student-takahashi", outsider = "student-yamamoto", leader = "leader-sato";
const { code } = await call("admin-initial", "admin/users", { purpose: "invite", email: "sales-sharing@legarea.jp", role: "sales" });
const { user: { id: owner } } = await call(null, "auth/register", {
  code, name: "共有テスト担当営業", email: "sales-sharing@legarea.jp", password: randomUUID(), role: "sales",
});
assert.equal((await dashboard(sales)).projects.length, 0, "Fresh database required");
const when = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) + "T13:00";
const makeAttachment = (name, text) => ({ name, contentBase64: Buffer.from(text).toString("base64") });
async function createAnswered(actor, project) {
  const created = await call(actor, "requests", {
    project, summary: "共通画面で閲覧する架空の案件概要", remarks: "営業共有の備考", upperCompany: "共有試験上位", endCompany: "共有試験エンド",
    leaderId: leader, studentIds: [student], candidates: [{start:when}], scheduleMode: "candidates",
    attachment: makeAttachment("共有試験.pdf", "original skill sheet"),
  });
  const item = (await dashboard(actor)).requests.find(r => r.id === created.requestId);
  await call(student, "requests/" + item.id + "/respond", {slotIds:[item.candidates[0].id]});
  return { ...created, actor, slotId:item.candidates[0].id };
}
const project = await createAnswered(owner, "別営業担当の情報共有案件");
const ownProject = await createAnswered(sales, "青木担当の情報共有案件");
const requestRoute = "requests/" + project.requestId + "/";
const sheet = requestRoute + "attachment";
async function readSheet(actor) {
  const response = await send(actor, sheet);
  assert.equal(response.status, 200);
  return response.text();
}

const before = await dashboard(owner);
assert.deepEqual(await dashboard(sales), before, "Both sales dashboards share cases, requests, previews and task state");
assert(before.projects.some(p => p.id === project.projectId && p.salesId === owner && p.remarks === "営業共有の備考"));
assert(before.notifications.length > 0);
assert((await dashboard(outsider)).projects.every(p => p.id !== project.projectId));
assert((await dashboard(student)).projects.every(p => !p.remarks));
assert.equal(await readSheet(sales), "original skill sheet");
assert.equal(await readSheet(student), "original skill sheet");
await call(outsider, sheet, undefined, 403);
await call(leader, sheet, undefined, 403);
await call(sales, sheet, makeAttachment("変更.pdf", "denied"), 403);
await call(sales, requestRoute + "confirm", {slotId:project.slotId}, 403);
const taskKey = "request-" + project.requestId;
const task = before.tasks.find(t => t.key === taskKey);
assert(task?.unread);
const acknowledge = "tasks/" + taskKey + "/acknowledge";
await call(sales, acknowledge, {revision:task.revision}, 403);

// The first request belongs to the caller and can be processed. The second must roll back both.
const mixed = [project,ownProject].sort((a,b) => a.requestId < b.requestId ? -1 : 1);
await call(mixed[0].actor, "requests/group-confirm", { requestIds:mixed.map(r => r.requestId), start:when }, 403);
assert.deepEqual(await dashboard(owner), before, "Denied changes must preserve requests, events, tasks and notifications");
assert.equal(await readSheet(sales), "original skill sheet");
await call(owner, acknowledge, {revision:task.revision});
const reviewed = (await dashboard(owner)).tasks.find(t => t.key === taskKey);
assert(reviewed.acknowledgedAt && !reviewed.unread);
assert.deepEqual((await dashboard(sales)).tasks.find(t => t.key === taskKey), reviewed);
await call(owner, sheet, makeAttachment("更新済み.pdf", "updated skill sheet"));
assert.equal(await readSheet(sales), "updated skill sheet");
const confirmed = await call(owner, requestRoute + "confirm", {slotId:project.slotId, url:"https://meet.example/shared"});
const eventRoute = "events/" + confirmed.eventId + "/";
const feedback = { duties:"試験設計", process:"レビュー", remote:"週2日", impression:"チームで工程を確認", questions:["どの工程を担当しましたか"], meetingFinished:true };
const beforeFeedback = await dashboard(owner);
for (const actor of [sales, owner, outsider]) await call(actor, eventRoute + "feedback", feedback, 403);
await call(sales, eventRoute + "result", {result:"offered"}, 403);
await call(sales, eventRoute + "notice", {}, 403);
await call(sales, eventRoute + "next-round", {}, 403);
assert.deepEqual(await dashboard(sales), beforeFeedback);
await call(student, eventRoute + "feedback", feedback, 409);
execFileSync(path.join(manifest.postgresBin, "psql.exe"), [
  "-XqAt", "-h", "127.0.0.1", "-p", String(manifest.postgresPort), "-U", "dealhunter", "-d", "dealhunter_end_companies_test",
  "-v", "ON_ERROR_STOP=1", "-v", "event=" + confirmed.eventId, "-f", "-",
], { input: "UPDATE scheduled_events SET event_date=CURRENT_DATE-1 WHERE id=:'event';", windowsHide: true });
await call(student, eventRoute + "feedback", feedback);
const after = await dashboard(sales);
assert(after.feedbacks.some(f => f.eventId === confirmed.eventId && f.impression === feedback.impression));
assert(after.questions.some(q => q.eventId === confirmed.eventId && q.title === feedback.questions[0]));
await call(owner, eventRoute + "result", {result:"offered"});
assert((await dashboard(sales)).events.some(e => e.key === confirmed.eventId && e.result === "offered"));
assert.deepEqual(await dashboard(sales), await dashboard(owner));
console.log("PASS: sales share project information, sheets, feedback, notifications and owner task state; only the owner edits and only the engineer submits feedback; mixed-owner confirmation rolls back.");
