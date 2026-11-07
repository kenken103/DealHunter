import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const key=(await readFile(".local/api-key","utf8")).trim(), password=(await readFile(".local/database.password","utf8")).trim();
const pg=process.env.DEALHUNTER_POSTGRES_BIN?`${process.env.DEALHUNTER_POSTGRES_BIN}/psql.exe`:"psql.exe";
const tables=["app_users","projects","scheduled_events","interview_questions","pending_tasks","interview_requests","candidate_slots","request_attachments","project_attachments","interview_feedback","notification_previews","task_acknowledgements"];
const fixtures=[];
function sql(statement,variables={}) {
 const args=["-X","-qAt","-h","127.0.0.1","-p","55432","-U","dealhunter","-d","dealhunter","-v","ON_ERROR_STOP=1"];
 for(const [k,v] of Object.entries(variables)) args.push("-v",`${k}=${v}`);
 args.push("-f","-");
 const r=spawnSync(pg,args,{input:statement,encoding:"utf8",timeout:20000,windowsHide:true,env:{...process.env,PGPASSWORD:password,PGCLIENTENCODING:"UTF8"}});
 assert(r.status===0,`Fixture SQL failed: ${r.stderr}`); return r.stdout.trim();
}
const snapshot=()=>sql(`SELECT jsonb_build_object(${tables.map(t=>`'${t}',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM ${t} x),'[]'::jsonb)`).join(",")})::text;`);
async function call(user,endpoint,body,expected=200) {
 const r=await fetch(`http://127.0.0.1:8080/api/${endpoint}`,{method:body===undefined?"GET":"POST",headers:{"X-DealHunter-Key":key,"X-DealHunter-User":user,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 assert(r.status===expected,`${user} ${endpoint}: expected ${expected}, got ${r.status}`); return r;
}
const dashboard=async user=>(await call(user,"dashboard")).json();
const file=(name,text)=>({name,contentBase64:Buffer.from(text).toString("base64")});
const bytes=async(user,id)=>Buffer.from(await(await call(user,`requests/${id}/attachment`)).arrayBuffer()).toString();
const before=snapshot();
try {
 const payload={project:`共通添付検証-${randomUUID()}`,summary:"参画者と面談者を別保存する検証",leaderId:"leader-sato",studentIds:["student-takahashi","student-yamamoto"],participantName:"参画 別人",participantNameKana:"は\u3099ん・たろう",candidates:[{start:"2026-11-20T10:00",end:"2026-11-20T10:45"}],attachment:file("共通.pdf","%PDF-shared")};
 for(const invalid of [{...payload,participantNameKana:"タロウ"},{...payload,participantName:"x".repeat(201)},{...payload,attachments:[file("a.pdf","a"),file("b.pdf","b")]},{...payload,attachment:[file("a.pdf","a")]}]) await call("sales-aoki","requests",invalid,400);
 assert(snapshot()===before,"Invalid inputs changed persisted data");
 const created=await(await call("sales-aoki","requests",payload)).json(); fixtures.push({id:created.projectId,name:payload.project});
 let data=await dashboard("sales-aoki");
 const a=data.requests.find(r=>r.projectId===created.projectId&&r.studentId==="student-takahashi"),b=data.requests.find(r=>r.projectId===created.projectId&&r.studentId==="student-yamamoto");
 for(const r of [a,b]) {assert(r.participantName==="参画 別人"&&r.participantNameKana==="ばん・たろう","Participant metadata mismatch"); assert(r.attachment.name==="共通.pdf"&&r.attachment.scope==="project","Shared metadata missing");}
 assert(await bytes("student-takahashi",a.id)==="%PDF-shared"); assert(await bytes("student-yamamoto",b.id)==="%PDF-shared");
 await call("student-takahashi",`requests/${b.id}/attachment`,undefined,403); await call("student-mori",`requests/${a.id}/attachment`,undefined,403); await call("leader-sato",`requests/${a.id}/attachment`,undefined,403);
 await call("student-yamamoto",`requests/${b.id}/attachment`,file("fake.pdf","x"),403);
 for(const bad of [file("../unsafe.pdf","x"),{name:"broken.pdf",contentBase64:"invalid-base64!"}]) await call("sales-aoki",`requests/${a.id}/attachment`,bad,400);
 await call("sales-aoki",`requests/${a.id}/attachment`,file("large.pdf",Buffer.alloc(5*1024*1024+1)),413);
 assert(await bytes("student-takahashi",a.id)==="%PDF-shared","Bad replacement changed original");
 await call("sales-aoki",`requests/${b.id}/attachment`,file("変更後.pdf","%PDF-replacement"));
 assert(await bytes("student-takahashi",a.id)==="%PDF-replacement"&&await bytes("student-yamamoto",b.id)==="%PDF-replacement");
 const leader=await dashboard("leader-sato"); assert(leader.requests.filter(r=>r.projectId===created.projectId).every(r=>r.attachment===null),"Leader received attachment metadata");
 assert(leader.projects.find(p=>p.id===created.projectId).participantName==="参画 別人","Leader participant missing");
 await call("student-takahashi",`requests/${a.id}/respond`,{slotIds:[a.candidates[0].id]});
 const confirmed=await(await call("sales-aoki",`requests/${a.id}/confirm`,{slotId:a.candidates[0].id,url:"https://meet.example/participant-test"})).json();
 data=await dashboard("sales-aoki"); assert(data.events.find(e=>e.key===confirmed.eventId).participantNameKana==="ばん・たろう","Event participant missing");
 const legacy={...payload,project:`旧添付保全検証-${randomUUID()}`}; delete legacy.attachment; delete legacy.participantName; delete legacy.participantNameKana;
 const old=await(await call("sales-aoki","requests",legacy)).json(); fixtures.push({id:old.projectId,name:legacy.project});
 data=await dashboard("sales-aoki"); const oldA=data.requests.find(r=>r.projectId===old.projectId&&r.studentId==="student-takahashi"),oldB=data.requests.find(r=>r.projectId===old.projectId&&r.studentId==="student-yamamoto");
 sql("INSERT INTO request_attachments(request_id,filename,content) VALUES(:'id','legacy.pdf',decode('6c6567616379','hex'));",{id:oldA.id});
 assert(await bytes("student-takahashi",oldA.id)==="legacy"); await call("student-yamamoto",`requests/${oldB.id}/attachment`,undefined,404); await call("student-yamamoto",`requests/${oldA.id}/attachment`,undefined,403);
 await call("sales-aoki",`requests/${oldB.id}/attachment`,file("追加共通.pdf","shared-new"));
 assert(await bytes("student-takahashi",oldA.id)==="shared-new"&&await bytes("student-yamamoto",oldB.id)==="shared-new");
 assert(sql("SELECT encode(content,'hex') FROM request_attachments WHERE request_id=:'id';",{id:oldA.id})==="6c6567616379","Legacy personal attachment overwritten");
 if(process.argv.includes("--restart")) {
  const restart=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File","scripts/start-backend.ps1","-Restart"],{encoding:"utf8",windowsHide:true,timeout:30000});
  assert(restart.status===0,"Java restart failed during persistence verification");
  data=await dashboard("sales-aoki");
  assert(data.projects.find(p=>p.id===created.projectId).participantNameKana==="ばん・たろう","Participant did not survive restart");
  assert(await bytes("student-takahashi",a.id)==="%PDF-replacement"&&await bytes("student-yamamoto",b.id)==="%PDF-replacement","Shared file did not survive restart");
  assert(await bytes("student-takahashi",oldA.id)==="shared-new","Legacy/common selection did not survive restart");
  console.log("PASS: real Java restart retained participant data and shared attachment bytes.");
 }
 console.log("PASS: one shared file, independent participant/NFC fields, member access, invalid inputs atomic, replacement shared, old personal bytes retained before explicit common upload.");
} finally {
 if(fixtures.length) {
  const encoded=Buffer.from(JSON.stringify(fixtures)).toString("hex");
  sql(`BEGIN; CREATE TEMP TABLE cleanup_target ON COMMIT DROP AS SELECT p.id FROM projects p JOIN jsonb_to_recordset(convert_from(decode(:'fixtures','hex'),'UTF8')::jsonb) f(id text,name text) ON p.id=f.id AND p.name=f.name WHERE p.sales_id='sales-aoki' AND p.leader_id='leader-sato' FOR UPDATE OF p; SELECT 1/(CASE WHEN count(*)=${fixtures.length} THEN 1 ELSE 0 END) FROM cleanup_target; DELETE FROM notification_previews WHERE project_id IN(SELECT id FROM cleanup_target); DELETE FROM task_acknowledgements WHERE project_id IN(SELECT id FROM cleanup_target); DELETE FROM interview_questions WHERE project_id IN(SELECT id FROM cleanup_target); DELETE FROM interview_feedback WHERE event_id IN(SELECT id FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_target)); DELETE FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_target) AND kind='entry'; DELETE FROM scheduled_events WHERE project_id IN(SELECT id FROM cleanup_target); DELETE FROM candidate_slots WHERE request_id IN(SELECT id FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_target)); DELETE FROM interview_requests WHERE project_id IN(SELECT id FROM cleanup_target); DELETE FROM projects WHERE id IN(SELECT id FROM cleanup_target); COMMIT;`,{fixtures:encoded});
 }
 assert(snapshot()===before,"Non-test data differs after cleanup");
 console.log("PASS: exact fixture cleanup; users and all 11 business tables unchanged.");
}
