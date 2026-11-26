import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// This verification changes data only in the disposable stack from -ProjectDeletion.
const root = process.env.DEALHUNTER_END_TEST_ROOT;
const database = "dealhunter_end_companies_test";
assert(root);
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), database);
const manifest = JSON.parse((await readFile(path.join(root, "processes.json"), "utf8")).replace(/^\uFEFF/, ""));
assert(manifest.testRoot === root && manifest.apiPort !== 8080 && ![15432, 55432].includes(manifest.postgresPort));
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();

function sql(input) {
  const result = spawnSync(path.join(manifest.postgresBin, "psql.exe"), [
    "-XqAt", "-h", "127.0.0.1", "-p", String(manifest.postgresPort), "-U", "dealhunter",
    "-d", database, "-v", "ON_ERROR_STOP=1", "-f", "-",
  ], { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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
  assert(statuses.includes(response.status), endpoint + ": " + response.status + " " + (data.error ?? ""));
  return { status: response.status, data };
}

const sales = "sales-aoki";
const other = "sales-deletion-other";
const student = "student-takahashi";
const leader = "leader-sato";
const target = "deletion-complete";
const independent = "deletion-keep";
const deletionPath = id => "projects/" + id + "/delete";
const remove = (id, statuses) => request(sales, deletionPath(id), { confirm: true }, statuses);

sql(`
BEGIN;
INSERT INTO app_users(id,display_name,role) VALUES('${other}','別の担当営業','sales');
CREATE TEMP TABLE deletion_fixture(id text,sales_id text,source_row integer) ON COMMIT DROP;
INSERT INTO deletion_fixture VALUES('${target}','${sales}',101),('${independent}','${other}',102);

INSERT INTO projects(id,name,sales_id,leader_id,upper_company,end_company,total_rounds)
SELECT id,'共通の案件名',sales_id,'${leader}','共通の上位会社','共通のエンド企業',2 FROM deletion_fixture;
INSERT INTO project_import_history(project_id,student_id,source_row,interview_date,status,source_data)
SELECT id,'${student}',source_row,'2024-02-10','joined','{}' FROM deletion_fixture;
INSERT INTO project_end_companies(project_id,name) SELECT id,'共通のエンド企業' FROM deletion_fixture;
INSERT INTO project_attachments(project_id,filename,content) SELECT id,'project.pdf','fixture' FROM deletion_fixture;
INSERT INTO recruitments(id,project_id,status,schedule_mode)
SELECT id||'-selection',id,'assigned','candidates' FROM deletion_fixture;
INSERT INTO recruitment_candidate_slots(id,recruitment_id,start_at)
SELECT id||'-selection-slot',id||'-selection','2032-03-10 10:00' FROM deletion_fixture;
INSERT INTO interview_requests(id,project_id,student_id,status,recruitment_id,interview_round,total_rounds)
SELECT id||'-confirmed',id,'${student}','confirmed',id||'-selection',2,2 FROM deletion_fixture
UNION ALL
SELECT id||'-pending',id,'student-yamamoto','requested',id||'-selection',1,2 FROM deletion_fixture;
INSERT INTO candidate_slots(id,request_id,start_at,interview_round)
SELECT id||'-slot',id||'-confirmed','2024-02-10 10:00',1 FROM deletion_fixture;
INSERT INTO request_attachments(request_id,filename,content)
SELECT id||'-confirmed','request.pdf','fixture' FROM deletion_fixture;
INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,request_id,status,result)
SELECT id||'-meet',id,'${student}','2024-02-10','10:00','meet','一次','オンライン',id||'-confirmed','entry-registered','passed'
FROM deletion_fixture;
INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,request_id,parent_event_id,status,result,interview_round)
SELECT id||'-entry',id,'${student}','2024-03-10','09:00','entry','入場','現地',id||'-confirmed',id||'-meet','entry-registered','passed',2
FROM deletion_fixture;
INSERT INTO interview_feedback(id,event_id,student_id,duties,process,remote,impression)
SELECT id||'-feedback',id||'-meet','${student}','業務','工程','場所','所感' FROM deletion_fixture;
INSERT INTO interview_questions(id,project_id,title,tag,context,display_order,event_id,feedback_id)
SELECT id||'-question',id,'共通の質問','業務','面談',1,id||'-meet',id||'-feedback' FROM deletion_fixture;
INSERT INTO event_notice_history(event_id,revision,state,start_at)
SELECT id||'-meet',1,'scheduled','2024-02-10 10:00' FROM deletion_fixture;
INSERT INTO pending_tasks(id,project_id,student_id,owner_role,title,body)
SELECT id||'-legacy-task',id,'${student}','sales','対応','内容' FROM deletion_fixture;
INSERT INTO task_acknowledgements(user_id,project_id,task_key,revision)
SELECT sales_id,id,id||'-task',1 FROM deletion_fixture;
INSERT INTO notification_previews(id,project_id,recipient_id,kind,title,lines)
SELECT id||'-preview',id,'${student}','lark','案内','[]' FROM deletion_fixture;
INSERT INTO lark_cancellation_notifications(id,project_id,recipient_id,message,sent_at)
SELECT gen_random_uuid(),id,'${student}','配信済みの通知',now() FROM deletion_fixture;

INSERT INTO interviewer_company_restrictions(sales_id,student_id,company_role,company_name)
VALUES('${sales}','${student}','end','共通のエンド企業');
INSERT INTO interview_request_drafts(id,sales_id,content) VALUES('deletion-kept-draft','${sales}','{"name":"共通の案件名"}');
INSERT INTO interviewer_availability_slots(id,student_id,start_at,end_at)
VALUES('deletion-kept-availability','${student}','2032-02-10 10:00','2032-02-10 11:00');
COMMIT;
`);

function related(id) {
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  const conditions = {
    projects: `id='${id}'`,
    project_import_history: `project_id='${id}'`,
    project_end_companies: `project_id='${id}'`,
    project_attachments: `project_id='${id}'`,
    recruitments: `project_id='${id}'`,
    recruitment_candidate_slots: `recruitment_id='${id}-selection'`,
    interview_requests: `project_id='${id}'`,
    candidate_slots: `request_id IN ('${id}-confirmed','${id}-pending')`,
    request_attachments: `request_id IN ('${id}-confirmed','${id}-pending')`,
    scheduled_events: `project_id='${id}'`,
    interview_feedback: `event_id IN ('${id}-meet','${id}-entry')`,
    interview_questions: `project_id='${id}'`,
    event_notice_history: `event_id IN ('${id}-meet','${id}-entry')`,
    pending_tasks: `project_id='${id}'`,
    task_acknowledgements: `project_id='${id}'`,
    notification_previews: `project_id='${id}'`,
    lark_cancellation_notifications: `project_id='${id}'`,
  };
  return JSON.parse(sql("SELECT jsonb_build_object(" + Object.entries(conditions)
    .map(([table, condition]) => "'" + table + "', (SELECT count(*) FROM " + table + " WHERE " + condition + ")")
    .join(",") + ");"));
}

function untouched() {
  return sql(`
    SELECT jsonb_build_array(
      (SELECT count(*) FROM app_users),
      (SELECT count(*) FROM leader_members WHERE leader_id='${leader}' AND student_id='${student}'),
      (SELECT count(*) FROM interviewer_company_restrictions WHERE sales_id='${sales}' AND company_name='共通のエンド企業'),
      (SELECT count(*) FROM interview_request_drafts WHERE id='deletion-kept-draft'),
      (SELECT count(*) FROM interviewer_availability_slots WHERE id='deletion-kept-availability')
    );
  `);
}

await request(sales, "requests/" + target + "-pending/cancel", { revision: 1 });
const before = related(target);
const keep = related(independent);
const untouchedBefore = untouched();
assert(Object.values(before).every(count => count > 0), "All deletion branches must be represented by fixture data");
assert.equal(before.lark_cancellation_notifications, 2, "Both pending and sent notifications must be associated with their project");
assert(Object.values(keep).every(count => count > 0));

for (const actor of [other, student, leader, "admin-initial"]) {
  await request(actor, deletionPath(target), { confirm: true }, [403]);
}
await request(null, deletionPath(target), { confirm: true }, [401]);
for (const body of [{}, { confirm: false }, { confirm: "true" }]) {
  await request(sales, deletionPath(target), body, [400]);
}
assert.deepEqual(related(target), before);

// A deferred failure must roll back the deletion of every dependent row.
sql(`
  CREATE FUNCTION block_project_deletion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.id='${target}' THEN RAISE EXCEPTION 'deletion rollback fixture'; END IF;
    RETURN OLD;
  END $$;
  CREATE CONSTRAINT TRIGGER block_project_deletion_fixture AFTER DELETE ON projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION block_project_deletion_fixture();
`);
await remove(target, [503]);
assert.deepEqual(related(target), before, "A failed database transaction must restore project and all dependants");
sql("DROP TRIGGER block_project_deletion_fixture ON projects; DROP FUNCTION block_project_deletion_fixture();");

const simultaneous = await Promise.all([remove(target, [200, 404, 409]), remove(target, [200, 404, 409])]);
assert.equal(simultaneous.filter(result => result.status === 200).length, 1);
assert.equal(simultaneous.find(result => result.status === 200).data.projectId, target);
await remove(target, [404]);
assert(Object.values(related(target)).every(count => count === 0));
assert.deepEqual(related(independent), keep);
assert.equal(untouched(), untouchedBefore);
const dashboard = (await request(sales, "dashboard")).data;
assert(!dashboard.projects.some(project => project.id === target));
assert(dashboard.projects.some(project => project.id === independent));
assert(!dashboard.requests.some(row => row.projectId === target));
assert(!dashboard.events.some(row => row.projectId === target));
await request(student, "requests/" + target + "-confirmed/attachment", undefined, [404]);

const create = async (project, options = {}) => (await request(sales, "requests", {
  project, summary: "隔離検証", upperCompany: "共通の上位会社", leaderId: leader,
  studentIds: [student], scheduleMode: "candidates", candidates: [{ start: "2032-09-10T14:00" }], ...options,
})).data;
const choosing = await create("選定待ち", { assignmentMode: "leader", studentIds: [] });
assert.equal((await remove(choosing.projectId)).data.projectId, choosing.projectId);
await request(leader, "recruitments/" + choosing.recruitmentId + "/assign", { studentIds: [student] }, [404]);

const booking = await create("日程確定との競合");
let bookingRow = (await request(sales, "dashboard")).data.requests.find(row => row.id === booking.requestId);
await request(student, "requests/" + bookingRow.id + "/respond", {
  revision: bookingRow.taskRevision, slotIds: [bookingRow.candidates[0].id],
});
bookingRow = (await request(sales, "dashboard")).data.requests.find(row => row.id === booking.requestId);
const [deletion] = await Promise.all([
  remove(booking.projectId, [200, 409]),
  request(sales, "requests/" + bookingRow.id + "/confirm", {
    revision: bookingRow.taskRevision, slotId: bookingRow.candidates[0].id,
  }, [200, 404, 409]),
]);
if (deletion.status === 409) await remove(booking.projectId);
assert(Object.values(related(booking.projectId)).every(count => count === 0));
const emptyProjects = ["deletion-standalone", "deletion-imported-only"];
sql(`
  INSERT INTO projects(id,name,sales_id) VALUES ('${emptyProjects[0]}','候補登録前','${sales}'),('${emptyProjects[1]}','取り込み案件','${sales}');
  INSERT INTO project_import_history(project_id,student_id,source_row,status,source_data)
  VALUES('${emptyProjects[1]}','${student}',103,'rejected','{}');
`);
for (const id of emptyProjects) {
  await remove(id);
  assert(Object.values(related(id)).every(count => count === 0));
}
assert.deepEqual(related(independent), keep);
assert.equal(untouched(), untouchedBefore);
console.log("PASS: ownership, explicit confirmation, complete dependent deletion, rollback, concurrent workflows and unrelated data");
