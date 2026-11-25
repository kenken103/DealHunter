import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const { DEALHUNTER_END_TEST_ROOT: root, DEALHUNTER_END_TEST_PSQL: psql,
  DEALHUNTER_END_TEST_API: api, DEALHUNTER_END_TEST_PGPORT: port } = process.env;
assert(root && psql && /^http:\/\/127\.0\.0\.1:\d+$/.test(api) && new URL(api).port !== "8080");
assert(/^\d+$/.test(port) && !["15432", "55432"].includes(port));
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert.equal(Number(port), manifest.postgresPort);
assert.equal(Number(new URL(api).port), manifest.apiPort);
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();

function sql(statement) {
  const result = spawnSync(psql, ["-XqAt", "-h", "127.0.0.1", "-p", port, "-U", "dealhunter",
    "-d", "dealhunter_end_companies_test", "-v", "ON_ERROR_STOP=1", "-f", "-"],
  { input: statement, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  return result.stdout.trim();
}

async function request(actor, endpoint, body, expected = 200) {
  const headers = { "X-DealHunter-Key": key, "Content-Type": "application/json" };
  if (actor) headers["X-DealHunter-User"] = actor;
  const response = await fetch(api + "/api/" + endpoint, {
    method: body === undefined ? "GET" : "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, endpoint + " " + JSON.stringify(data));
  return data;
}

const owner = "sales-aoki", other = "qa-sales", otherName = "検証営業";
const students = ["student-takahashi", "student-yamamoto"];
const draft = {
  project: "冷蔵配送の配車計画 V2",
  summary: "食品配送センター向けに冷蔵トラックの配車計画を計算し、倉庫別の積載量と走行経路を最適化するシステムの設計と検証を担当します。",
  upperCompany: "株式会社朝凪物流", endCompany: "霧島食品",
};
const create = (actor, fields) => request(actor, "requests", {
  leaderId: "leader-sato", studentIds: students, scheduleMode: "availability", candidates: [],
  ...fields,
});
async function find(fields, actor = owner) {
  const data = await request(actor, "similar-projects", fields);
  assert.deepEqual(Object.keys(data), ["matches"]);
  assert(Array.isArray(data.matches));
  return data.matches;
}
const counts = () => sql(`SELECT (SELECT count(*) FROM projects), (SELECT count(*) FROM interview_requests),
  (SELECT count(*) FROM recruitments), (SELECT count(*) FROM notification_previews), (SELECT count(*) FROM task_acknowledgements);`);

assert.equal(sql("SELECT count(*) FROM projects;"), "0", "Fresh test database required");
sql("INSERT INTO app_users(id,display_name,role) VALUES ('qa-sales','検証営業','sales');");
assert.deepEqual(await find(draft), []);
const mine = await create(owner, draft);
const theirs = await create(other, {
  ...draft, upperCompany: "架空別商事", participantName: "検証専用参画者", remarks: "共有禁止の営業メモ",
});
const sharedIntro = "いつもお世話になっております。下記案件をご紹介いたします。ご確認のほどよろしくお願いいたします。";
await create(owner, { ...draft, project: "運用支援", summary: sharedIntro + "郵便物の仕分けと宛先ごとの封入を担当。" });
const sharedSkills = "\n【必須スキル】Java / JavaScript / TypeScript / Spring Boot / PostgreSQL / Oracle / AWS / Linux / Docker / Git";
const withSkills = { ...draft, project: "システム開発支援", summary: "古書の表紙画像を照合して損傷箇所を検知し修繕費用を集計する。" + sharedSkills };
await create(owner, withSkills);
const initial = counts();

const matches = await find({ ...draft, project: "冷蔵配送の配車計画 ｖ２", upperCompany: "（株）朝凪物流" });
assert.deepEqual(matches.map(m => [m.scope, m.score]), [["own", 100], ["other", 90]], "Two interviewers must count as one project");
const [own, foreign] = matches;
assert.equal(own.projectId, mine.projectId);
assert.equal(own.projectName, draft.project);
assert.equal(own.summary, draft.summary);
assert.deepEqual(Object.keys(foreign).sort(), ["scope", "salesName", "score", "reasons", "projectId", "projectName", "summary"].sort());
assert.equal(foreign.projectId, theirs.projectId);
assert.equal(foreign.projectName, draft.project);
assert.equal(foreign.summary, draft.summary);
assert.equal(foreign.salesName, otherName);
assert(Array.isArray(foreign.reasons) && foreign.reasons.length > 0 && foreign.reasons.every(r => typeof r === "string"));
assert.equal((await find(draft, other)).find(m => m.scope === "own")?.projectId, theirs.projectId);
assert.deepEqual((await find({ ...draft, endCompany: "" })).map(m => m.score), [100, 89], "Missing company must leave the denominator");
const reworded = await find({ ...draft, summary: draft.summary.replace("システムの設計と検証を担当します。", "システムの設計と試験を行います。") });
assert(reworded.some(m => m.scope === "other" && m.score >= 75 && m.score < 90), "Near match across suppliers");
assert.deepEqual(await find({ ...draft, summary: "医療機関の受付で診察券の発行や問診票の保管を行い、外来患者の案内をする業務。" }), []);
assert.deepEqual(await find({ ...draft, summary: "在庫管理" }), []);
assert.deepEqual(await find({ ...draft, project: "運用支援", summary: sharedIntro + "宿泊施設の客室清掃と寝具交換を担当。" }), []);
assert.deepEqual(await find({ ...withSkills, summary: "養蜂場で季節ごとの気温推移から越冬時期を予測し巣箱の移動経路を作成する。" + sharedSkills }), [],
  "Shared technology lists must not outweigh unrelated work descriptions");
await request(owner, "similar-projects", { ...draft, summary: "" }, 400);
for (const actor of ["leader-sato", students[0], "admin-initial", null]) {
  await request(actor, "similar-projects", draft, actor ? 403 : 401);
}
assert.equal(counts(), initial, "Preview must not register projects, requests, recruitment, notifications or acknowledgements");

const blankEnd = await create(owner, { ...draft, endCompany: "" });
await create(owner, { ...draft, upperCompany: "別の上位会社", endCompany: "別の荷主" });
const beforeRanking = counts();
const top = await find(draft);
assert.deepEqual(top.map(m => m.score), [100, 100, 90], "At most three highest scores, sorted");
assert.equal(top.find(m => m.projectId === blankEnd.projectId)?.score, 100, "Legacy missing company must leave the denominator");
assert.equal(counts(), beforeRanking);
console.log("PASS: cross-sales similarity, normalization, missing companies, top three per project, insufficient or unrelated content, restricted responses and read-only preview.");

const groupEndpoint = "question-groups";
assert.deepEqual(await request(owner, groupEndpoint), { groups: [] }, "A project without questions does not create a group");
const rephrased = draft.summary.replace("システムの設計と検証を担当します。", "システムの設計と試験を行います。");
const medical = "医療機関の受付で診察券の発行や問診票の保管を行い、外来患者の案内をする業務。";
sql(`
  INSERT INTO projects (id,name,sales_id,notes,upper_company,prime_company,end_company) VALUES
    ('question-group-a','冷蔵物流の配車計画','${owner}','${draft.summary}','上位会社A','','株式会社霧島食品'),
    ('question-group-b','食品配送ルート最適化','${other}','${rephrased}','上位会社B','','霧島食品（株）'),
    ('question-group-other-end','別エンドの配車案件','${owner}','${draft.summary}','上位会社A','','別のエンド'),
    ('question-group-other-business','医療受付システム','${owner}','${medical}','上位会社A','','株式会社霧島食品'),
    ('question-group-other-company','類似するが別の会社','${owner}','${draft.summary}','上位会社C','',''),
    ('question-group-too-short-a','概要不足A','${owner}','配送支援','短い概要の会社','',''),
    ('question-group-too-short-b','概要不足B','${owner}','配送支援','短い概要の会社','',''),
    ('question-group-prime-a','受付電子化','${owner}','${medical}','別の上位A','こもれびソフト株式会社',''),
    ('question-group-prime-b','電子診察券','${other}','${medical}','別の上位B','（株）こもれびソフト',''),
    ('question-group-bridge-a','施設検証A','${owner}','${draft.summary}','共通商社','',''),
    ('question-group-bridge-b','施設検証B','${owner}','${draft.summary}','共通商社 → 別の商社','',''),
    ('question-group-bridge-c','施設検証C','${owner}','${draft.summary}','別の商社','','');
  INSERT INTO scheduled_events (id, project_id, student_id, event_date, start_time, kind, route, format, interview_round) VALUES
    ('question-group-round-1','question-group-a','${students[0]}',CURRENT_DATE-3,'13:00','meet','直','オンライン',1),
    ('question-group-round-2','question-group-a','${students[0]}',CURRENT_DATE-2,'13:00','meet','直','オンライン',2),
    ('question-group-original-event','question-group-b','${students[0]}',CURRENT_DATE-1,'13:00','meet','直','オンライン',1);
  INSERT INTO interview_questions (id, project_id,title,tag,context,display_order)
    SELECT id||'-q1',id,'設計で重視した点は何ですか？','面談記録','検証用の質問',1
    FROM projects WHERE id LIKE 'question-group-%';
  UPDATE interview_questions SET event_id='question-group-original-event' WHERE id='question-group-b-q1';
  UPDATE interview_questions SET event_id='question-group-round-1' WHERE id='question-group-a-q1';
  INSERT INTO interview_questions (id, project_id,title,tag,context,display_order)
    VALUES ('question-group-a-q2','question-group-a','試験の進め方を教えてください。','面談記録','検証用の質問',2);
  UPDATE interview_questions SET event_id='question-group-round-2' WHERE id='question-group-a-q2';
  INSERT INTO interview_questions (id, project_id,title,tag,context,display_order)
    VALUES ('question-group-a-q3','question-group-a','体制について教えてください。','面談記録','検証用の質問',3);
`);
const expected = {
  groups: [
    { projectIds: ["question-group-a", "question-group-b"], companyName: "株式会社霧島食品" },
    { projectIds: ["question-group-bridge-a", "question-group-bridge-b"], companyName: "共通商社" },
    { projectIds: ["question-group-bridge-c"], companyName: "別の商社" },
    { projectIds: ["question-group-other-business"], companyName: "株式会社霧島食品" },
    { projectIds: ["question-group-other-company"], companyName: "上位会社C" },
    { projectIds: ["question-group-other-end"], companyName: "別のエンド" },
    { projectIds: ["question-group-prime-a", "question-group-prime-b"], companyName: "こもれびソフト株式会社" },
    { projectIds: ["question-group-too-short-a"], companyName: "短い概要の会社" },
    { projectIds: ["question-group-too-short-b"], companyName: "短い概要の会社" },
  ],
};
const questionsBefore = sql("SELECT count(*) FROM interview_questions;");
assert.deepEqual(await request(owner, groupEndpoint), expected);
assert.deepEqual(await request(other, groupEndpoint), expected);
for (const actor of ["leader-sato", students[0], "admin-initial", null]) {
  await request(actor, groupEndpoint, undefined, actor ? 403 : 401);
}
await request(owner, groupEndpoint, {}, 405);
assert.equal(sql("SELECT count(*) FROM interview_questions;"), questionsBefore, "Grouping must not rewrite question records");
console.log("PASS: question groups, company match across roles, same end priority, different end, unrelated or short summaries, transitive split, sales-only and read-only.");
