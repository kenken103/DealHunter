import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

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
    "-XqAt", "-h", "127.0.0.1", "-p", String(manifest.postgresPort), "-U", "dealhunter", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f", "-",
  ], { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const actor = "sales-aoki";
const other = "other-sales";
const collection = "request-drafts";
async function api(method, route, body, user = actor, expected = 200) {
  const headers = { "X-DealHunter-Key": key };
  if (user) headers["X-DealHunter-User"] = user;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${manifest.apiPort}/api/${route}`, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (expected !== null) assert.equal(response.status, expected, method + " " + route + " " + (data.error || ""));
  return expected === null ? {status: response.status, data} : data;
}
const attachment = { name: "skill.pdf", contentBase64: Buffer.from("example pdf").toString("base64") };
const content = { version: 1, values: { project: "", remarks: "not final" }, selectedStudents: [], slots: [""], requestedDates: [],
  scheduleMode: "candidates", assignmentMode: "direct", addingUpperCompany: true, addingEndCompany: false, attachment };
const finalPayload = { project:"submitted", upperCompany:"company", summary:"Overview", leaderId:"leader-sato",
  studentIds:["student-takahashi"], assignmentMode:"direct", scheduleMode:"availability", attachment };
const creationKey = randomUUID();
sql("INSERT INTO app_users(id,display_name,role) VALUES ('other-sales','Other','sales')");
const first = await api("POST", collection, {content,creationKey});
const firstRoute = collection + "/" + first.id;
assert.equal(first.revision,1);
assert.deepEqual(await api("POST",collection,{content,creationKey}),first);
assert.deepEqual((await api("GET",firstRoute)).content,content);
assert.deepEqual((await api("GET",collection)).drafts,[first]);
assert.deepEqual(Object.keys(first).sort(),["id","revision","title","updatedAt"]);
const second = await api("POST",collection,{content:{...content,attachment:null}});
assert.notEqual(first.id,second.id);
assert.equal((await api("GET",collection)).drafts.length,2);
await api("GET",collection,undefined,null,401);
for (const denied of ["student-takahashi","leader-sato","admin-initial"]) {
  await api("GET",collection,undefined,denied,403);
  await api("POST",collection,{content},denied,403);
}
assert.deepEqual((await api("GET",collection,undefined,other)).drafts,[]);
await api("GET",firstRoute,undefined,other,404);
assert.equal((await api("PUT",firstRoute,{revision:1,content},other,409)).code,"DRAFT_CONFLICT");
await api("DELETE",firstRoute,{revision:1},other,409);
await api("POST","requests",{...finalPayload,draftId:first.id,draftRevision:1},other,409);
await api("POST",collection,{content:{...content,attachment:{...attachment,name:"bad.exe"}}},actor,400);
await api("POST",collection,{content:{...content,attachment:{...attachment,contentBase64:Buffer.alloc(5*1024*1024+1).toString("base64")}}},actor,413);
const updatedContent = {...content,values:{project:"Draft title"},attachment:null};
const updates = await Promise.all([1,2].map(()=>api("PUT",firstRoute,{revision:1,content:updatedContent},actor,null)));
assert.deepEqual(updates.map(entry=>entry.status).sort(),[200,409]);
const updated = (await api("GET",firstRoute));
assert.equal(updated.revision,2);
assert.equal(updated.title,"Draft title");
assert.deepEqual(updated.content,updatedContent);
await api("DELETE",firstRoute,{revision:1},actor,409);
await api("POST","requests",{...finalPayload,draftId:first.id,draftRevision:1},actor,409);
await api("POST","requests",{draftId:first.id,draftRevision:2},actor,400);
assert.equal((await api("GET",firstRoute)).revision,2);
assert.equal(sql("SELECT count(*) FROM projects"),"0");
assert.equal(sql("SELECT count(*) FROM notification_previews"),"0");
const send = {...finalPayload,draftId:first.id,draftRevision:2};
const sent = await Promise.all([1,2].map(()=>api("POST","requests",send,actor,null)));
assert.deepEqual(sent.map(entry=>entry.status).sort(),[200,409]);
await api("GET",firstRoute,undefined,actor,404);
assert.equal(sql("SELECT count(*) FROM interview_requests"),"1");
assert.equal(sql("SELECT count(*) FROM project_attachments"),"1");
const recruitment = await api("POST","requests",{...finalPayload,assignmentMode:"leader",studentIds:[],draftId:second.id,draftRevision:1});
assert(recruitment.recruitmentId);
assert.equal(sql("SELECT count(*) FROM recruitments"),"1");
const discard = await api("POST",collection,{content});
await api("DELETE",collection+"/"+discard.id,{revision:1});
assert.deepEqual((await api("GET",collection)).drafts,[]);
console.log("PASS: private drafts, replay, attachment validation, revision races, atomic registration in both assignment modes and rollback.");
