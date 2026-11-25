import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Use only the disposable local cluster created by verify-end-companies.ps1 -EngineerStatus.
const root = process.env.DEALHUNTER_END_TEST_ROOT;
assert(root);
const database = "dealhunter_end_companies_test";
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), database);
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert.equal(manifest.testRoot, root);
assert(manifest.apiPort > 0 && manifest.apiPort !== 8080);
assert(manifest.postgresPort > 0 && ![15432, 55432].includes(manifest.postgresPort));
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();

function sql(input) {
  const result = spawnSync(path.join(manifest.postgresBin, "psql.exe"), [
    "-XqAt", "-h", "127.0.0.1", "-p", String(manifest.postgresPort), "-U", "dealhunter",
    "-d", database, "-v", "ON_ERROR_STOP=1", "-f", "-",
  ], { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}

async function request(actor, expectedStatus = 200, method = "GET", endpoint = "engineer-status") {
  const headers = { "X-DealHunter-Key": key };
  if (actor) headers["X-DealHunter-User"] = actor;
  const response = await fetch(`http://127.0.0.1:${manifest.apiPort}/api/${endpoint}`, {
    headers, method, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

sql(`
  BEGIN;
  UPDATE leader_members SET active=false WHERE student_id='student-ito';
  INSERT INTO projects(id,name,sales_id,leader_id,upper_company,notes,remarks)
    SELECT id, id, 'sales-aoki', 'leader-suzuki', 'Example partner', 'Shared overview', 'Private sales note'
    FROM unnest(ARRAY['live','imported','overlap','pending','result-only','declined','cancelled','upcoming','unassigned']) AS names(id);
  INSERT INTO project_import_history(project_id,student_id,source_row,interview_date,entry_date,outcome,status,source_data) VALUES
    ('imported','student-takahashi',2,NULL,NULL,'Started','joined','{}'),
    ('overlap','student-takahashi',3,'2025-01-01','2025-01-01','','joined','{}'),
    ('declined','student-takahashi',4,'2025-02-04','2025-01-01','Withdrawn','declined','{}'),
    ('upcoming','student-takahashi',5,'2099-01-01',NULL,'','unknown','{}'),
    ('unassigned',NULL,6,'2025-02-03',NULL,'','rejected','{}');
  INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,engineer_confirmed_at,schedule_state) VALUES
    ('e1','live','student-takahashi','2025-02-01','09:00','entry','','',now(),'scheduled'),
    ('e2','overlap','student-takahashi','2025-02-02','09:00','entry','','',now(),'scheduled'),
    ('e3','pending','student-takahashi','2025-02-03','09:00','entry','','',NULL,'scheduled'),
    ('e4','result-only','student-takahashi','2025-02-04','09:00','meet','','',now(),'scheduled'),
    ('e5','cancelled','student-takahashi','2025-02-05','09:00','entry','','',now(),'cancelled'),
    ('e6','live','student-sasaki','2025-02-06','09:00','entry','','',now(),'scheduled');
  INSERT INTO interview_requests(id,project_id,student_id,status,total_rounds)
    VALUES ('history-request','result-only','student-takahashi','confirmed',3);
  UPDATE scheduled_events SET request_id='history-request',result='advanced' WHERE id='e4';
  INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,schedule_state,request_id,interview_round,result,meeting_url) VALUES
    ('round-2','result-only','student-takahashi','2025-02-04','15:00','meet','','','scheduled','history-request',2,'offered','https://example.test/private-meeting'),
    ('postponed','pending','student-takahashi','2025-02-12','09:00','meet','','','postponed',NULL,1,'pending',''),
    ('cancelled','cancelled','student-takahashi','2025-02-11','09:00','meet','','','cancelled',NULL,1,'pending',''),
    ('upcoming','upcoming','student-takahashi','2099-01-01','09:00','meet','','','scheduled',NULL,1,'pending',''),
    ('other-student','result-only','student-sasaki','2025-02-10','09:00','meet','','','scheduled',NULL,1,'pending','');
  INSERT INTO interview_feedback(id,event_id,student_id,duties,process,remote,impression) VALUES
    ('history-feedback-1','e4','student-takahashi','Implementation','Design','Hybrid','First interview impression'),
    ('history-feedback-2','round-2','student-takahashi','','','','Second interview impression'),
    ('history-feedback-other','other-student','student-sasaki','','','','Other student impression');
  INSERT INTO interview_questions(id,project_id,title,tag,context,display_order,event_id,feedback_id) VALUES
    ('history-question-2','result-only','Second question','interview','Question context',2,'e4','history-feedback-1'),
    ('history-question-1','result-only','First question','interview','',1,'e4','history-feedback-1'),
    ('history-question-round','result-only','Question for second round','interview','',3,'round-2','history-feedback-2'),
    ('history-question-event','result-only','Question recorded by event','interview','',4,'e4',NULL),
    ('history-question-shared','result-only','Shared practice question','interview','',5,NULL,NULL),
    ('history-question-mismatch','result-only','Wrong feedback link','interview','',6,'e4','history-feedback-other'),
    ('history-question-other','result-only','Other student question','interview','',7,'other-student','history-feedback-other');
  COMMIT;
`);

const sales = (await request("sales-aoki")).engineers;
assert.equal(sales.length, 9);
const own = (await request("leader-sato")).engineers;
assert.deepEqual(own.map(row => row.id).sort(),
  ["student-kobayashi", "student-mori", "student-takahashi", "student-yamamoto"]);
const member = own.find(row => row.id === "student-takahashi");
assert.deepEqual(member, sales.find(row => row.id === member.id));
assert.deepEqual(member.projects.map(project => [project.id,project.entryDate]), [
  ["overlap", "2025-02-02"], ["live", "2025-02-01"], ["imported", null],
]);
assert(member.projects.every(project => project.upperCompany === "Example partner" && project.notes === "Shared overview"));
assert(!JSON.stringify(own).includes("Private sales note"));
assert.deepEqual(own.find(row => row.id === "student-yamamoto").projects, []);
const outsiders = (await request("leader-suzuki")).engineers;
assert(!outsiders.some(row => row.id === member.id));
assert.deepEqual(outsiders.find(row => row.id === "student-sasaki").projects.map(project => project.id), ["live"]);
assert.deepEqual((await request("leader-sato", 200, "GET", "dashboard")).projects, []);

const historyFor = studentId => `engineer-interview-history/${studentId}`;
const historyPath = historyFor(member.id);
const history = await request("sales-aoki", 200, "GET", historyPath);
assert.deepEqual(history.engineer, { id: member.id, name: member.name });
assert.deepEqual(await request("leader-sato", 200, "GET", historyPath), history);
assert.deepEqual(history.interviews.map(row => [row.id,row.interviewDate,row.interviewTime,row.round,row.totalRounds,row.result,row.resultText]), [
  ["event:round-2", "2025-02-04", "15:00", 2, 3, "offered", null],
  ["event:e4", "2025-02-04", "09:00", 1, 3, "advanced", null],
  ["import:declined", "2025-02-04", null, null, null, "declined", "Withdrawn"],
  ["import:overlap", "2025-01-01", null, null, null, "joined", null],
  ["import:imported", null, null, null, null, "joined", "Started"],
]);
assert(history.interviews.every(row => row.upperCompany === "Example partner" && row.notes === "Shared overview"));
assert.deepEqual(history.interviews[0].questions, ["Question for second round"]);
assert.deepEqual(history.interviews[0].feedback, { duties: "", process: "", remote: "", impression: "Second interview impression" });
assert.deepEqual(history.interviews[1].questions, ["First question", "Second question", "Question recorded by event"]);
assert.deepEqual(history.interviews[1].feedback, {
  duties: "Implementation", process: "Design", remote: "Hybrid", impression: "First interview impression",
});
assert(history.interviews.slice(2).every(row => !row.questions.length && row.feedback === null));
assert(!JSON.stringify(history).includes("Other student impression"));
assert(!JSON.stringify(history).includes("Question context"));
assert(!JSON.stringify(history).includes("Private sales note"));
assert(!JSON.stringify(history).includes("private-meeting"));
assert.deepEqual((await request("leader-sato", 200, "GET", historyFor("student-yamamoto"))).interviews, []);
await request("leader-suzuki", 404, "GET", historyPath);
await request("leader-sato", 404, "GET", historyFor("student-ito"));
await request("sales-aoki", 404, "GET", historyFor("student-missing"));
await request("sales-aoki", 404, "GET", historyFor("leader-sato"));
await request("student-takahashi", 403, "GET", historyPath);
await request("admin-initial", 403, "GET", historyPath);
await request(null, 401, "GET", historyPath);
await request("sales-aoki", 405, "POST", historyPath);

sql("UPDATE leader_members SET active=false WHERE leader_id='leader-sato';");
assert.deepEqual((await request("leader-sato")).engineers, []);
await request("leader-sato", 404, "GET", historyPath);
await request("student-takahashi", 403);
await request("admin-initial", 403);
await request(null, 401);
await request("sales-aoki", 405, "POST");
console.log("PASS: roster visibility, empty teams, active entries, overlap, member details and read-only access");
console.log("PASS: interview history filters, rounds, questions, feedback, imported results, private fields and role boundaries");
