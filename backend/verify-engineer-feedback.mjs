import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";

// Run with scripts/verify-end-companies.ps1 -EngineerFeedback (fresh disposable database).
const { DEALHUNTER_END_TEST_API: api, DEALHUNTER_END_TEST_PSQL: psql, DEALHUNTER_END_TEST_ROOT: root, DEALHUNTER_END_TEST_PGPORT: port } = process.env;
assert(root && psql && /^http:\/\/127\.0\.0\.1:\d+$/.test(api) && new URL(api).port !== "8080");
assert(/^\d+$/.test(port) && !["15432", "55432"].includes(port));
const database = "dealhunter_end_companies_test";
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"),"utf8")).trim(), database);
const key = (await readFile(path.join(root,"api-key"),"utf8")).trim();
const owner = "student-takahashi", other = "student-yamamoto", sales = "sales-aoki";
function sql(input) {
  const result = spawnSync(psql,["-XqAt","-h","127.0.0.1","-p",port,"-U","dealhunter","-d",database,"-v","ON_ERROR_STOP=1","-f","-"],
    {input,encoding:"utf8",windowsHide:true});
  assert.equal(result.status,0,result.stderr);
}
async function request(user, route, body, status=200) {
  const response=await fetch(api+"/api/"+route,{method:body===undefined?"GET":"POST",
    headers:{"Content-Type":"application/json","X-DealHunter-Key":key,"X-DealHunter-User":user},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const result=await response.json();
  assert.equal(response.status,status,route+" "+(result.error||""));
  return result;
}
sql(`
  INSERT INTO projects(id,name,sales_id,notes,upper_company)
    SELECT id,id,'${sales}','顧客向け受注管理システムの設計と開発、データ移行試験。JavaとSQLを使用して運用まで支援します。','テスト上位'
    FROM unnest(ARRAY['FB-past','FB-next','FB-other']) id;
  INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format) VALUES
    ('FB-1','FB-past','${owner}',CURRENT_DATE-2,'09:00','meet','面談','オンライン'),
    ('FB-2','FB-next','${owner}',CURRENT_DATE+2,'10:00','meet','面談','オンライン'),
    ('FB-3','FB-other','${other}',CURRENT_DATE-2,'09:00','meet','面談','オンライン'),
    ('FB-entry','FB-past','${owner}',CURRENT_DATE+3,'10:00','entry','初回入場','受付');
`);
const feedback={duties:"開発",process:"設計",remote:"週2日",impression:"説明を聞いた",questions:["設計時に大切にする点は？"]};
const draft={content:{...feedback,reason:""},version:0,baseRevision:0};
const dash=user=>request(user,"dashboard");
await request(owner,"events/FB-2/feedback",{...feedback,meetingFinished:true},409);
await request(owner,"events/FB-entry/notice-read",{revision:1});
await request(owner,"events/FB-entry/acknowledge",{revision:1},409);
assert.equal((await dash(owner)).events.find(e=>e.key==="FB-entry").engineerConfirmedAt,null);
await request(owner,"events/FB-1/feedback-draft",draft);
await request(owner,"events/FB-1/feedback-draft",draft,409);
await request(other,"events/FB-1/feedback-draft",draft,403);
assert.equal((await dash(owner)).feedbackDrafts[0].content.remote,feedback.remote);
assert.equal((await dash(sales)).feedbackDrafts.length,0);
await request(owner,"events/FB-1/feedback",feedback,400);
await request(owner,"events/FB-1/feedback",{...feedback,draftVersion:0,meetingFinished:true},409);
await request(owner,"events/FB-1/feedback",{...feedback,draftVersion:1,meetingFinished:true});
await request(owner,"events/FB-1/feedback",{...feedback,revision:1,reason:"補足",impression:"説明の追記",questions:["訂正版"]});
await request(owner,"events/FB-1/feedback",{...feedback,revision:1,reason:"別端末の古い内容"},409);
const engineer=await dash(owner), latest=(await dash(sales)).feedbacks.find(f=>f.eventId==="FB-1");
assert.equal(engineer.feedbackDrafts.length,0);
assert.equal(latest.revision,2);
assert.deepEqual(latest.questions,["訂正版"]);
assert.deepEqual(latest.edits[0].previous.questions,feedback.questions);
assert.equal(latest.edits[0].reason,"補足");
const groups=(await request(owner,"question-groups")).groups;
assert(groups.some(g=>g.projectIds.includes("FB-past") && g.projectIds.includes("FB-next")));
assert(!groups.some(g=>g.projectIds.includes("FB-other")));
sql("UPDATE scheduled_events SET event_date=CURRENT_DATE-1,schedule_state='postponed',notice_revision=2 WHERE id='FB-entry';");
await request(owner,"events/FB-entry/acknowledge",{revision:2},409);
sql("UPDATE scheduled_events SET schedule_state='scheduled',notice_revision=3 WHERE id='FB-entry';");
await request(owner,"events/FB-entry/acknowledge",{revision:2},409);
await request(owner,"events/FB-entry/acknowledge",{revision:3});
assert((await dash(owner)).events.find(e=>e.key==="FB-entry").engineerConfirmedAt);
console.log("PASS: future and revised entry guards, feedback timing, private versioned drafts, correction history, scoped related questions.");
