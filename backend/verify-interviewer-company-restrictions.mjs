import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const { DEALHUNTER_END_TEST_ROOT: root, DEALHUNTER_END_TEST_PSQL: psql, DEALHUNTER_END_TEST_API: api, DEALHUNTER_END_TEST_PGPORT: port } = process.env;
assert(root && psql && /^http:\/\/127\.0\.0\.1:\d+$/.test(api) && new URL(api).port !== "8080");
assert(/^\d+$/.test(port) && !["15432", "55432"].includes(port));
assert.equal((await readFile(path.join(root, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const key = (await readFile(path.join(root, "api-key"), "utf8")).trim();
const owner = "sales-aoki", other = "qa-sales", person = "student-takahashi", twin = "qa-student-twin";
const end = "夕凪電工", upper = "朝凪工業", similar = "夕凪 電工", secret = "雪国テスト", prime = "架空元請商事";
const empty = { end: [], upper: [] };
const saved = { end: [end], upper: [upper] };
const importedCompanies = ["取込上位商事", "取込元請工業", "取込エンド通信"];
const extraPartner = "取込協力会社";
const manualCompany = "カタログ未登録の過去取引先";
let pastCompanies = [];

function sql(statement) {
  const result = spawnSync(psql, ["-XqAt", "-h", "127.0.0.1", "-p", port, "-U", "dealhunter", "-d", "dealhunter_end_companies_test", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: statement, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  return result.stdout.trim();
}

async function request(user, endpoint, body, expected = 200) {
  const response = await fetch(api + "/api/" + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": key, ...(user && { "X-DealHunter-User": user }), "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (expected === "invalid") assert([400, 403, 404, 422].includes(response.status), endpoint + " " + response.status);
  else assert.equal(response.status, expected, endpoint + " " + JSON.stringify(data));
  return data;
}

const candidates = "interviewer-company-candidates";
const lookup = "interviewer-company-lookup";
const endpoint = id => "interviewer-company-restrictions/" + encodeURIComponent(id);
const read = (user = owner, id = person) => request(user, endpoint(id));
const write = (companyRole, companyName, restricted, user = owner, id = person, expected) =>
  request(user, endpoint(id), { companyRole, companyName, restricted }, expected);
async function expectState(user, id, restrictions, ownRestrictions = restrictions) {
  const result = await read(user, id);
  const names = id === person ? pastCompanies : [];
  assert.deepEqual({ ...result, historyCompanies: new Set(result.historyCompanies) },
    { studentId: id, restrictions: { all: [], ...restrictions }, ownRestrictions: { all: [], ...ownRestrictions }, historyCompanies: new Set(names) });
}
const mark = (studentId, companyRole, companyName) => ({ studentId, companyRole, companyName });
async function expectLookup(user, expectedMarks) {
  const result = await request(user, lookup);
  assert.deepEqual(Object.keys(result).sort(), ["companies", "historyCompanies", "restrictions", "students"]);
  const expectedStudents = JSON.parse(sql("SELECT json_agg(json_build_object('id',id,'name',display_name)) FROM app_users WHERE role='student';"));
  const byId = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual(result.students.toSorted(byId), expectedStudents.sort(byId), "Include every current engineer by ID, including those without any requests");
  const byMark = (a, b) => a.studentId.localeCompare(b.studentId) || a.companyRole.localeCompare(b.companyRole) || a.companyName.localeCompare(b.companyName);
  assert.deepEqual(result.restrictions.toSorted(byMark), expectedMarks.toSorted(byMark), "All sales see the same explicit NG marks for current engineers");
  assert.deepEqual(new Set(result.historyCompanies.map(row => row.studentId + ":" + row.companyName)),
    new Set(pastCompanies.map(name => person + ":" + name)), "All sales see the same past interview companies by engineer ID");
  const registered = await request(user, candidates);
  assert.deepEqual(Object.keys(result.companies).sort(), ["all", "end", "prime", "upper"]);
  assert.deepEqual(new Set(result.companies.all), new Set(expectedMarks.filter(row => row.companyRole === "all").map(row => row.companyName)));
  for (const name of pastCompanies) assert(Object.values(result.companies).flat().includes(name));
  for (const role of ["end", "upper"]) {
    assert(registered[role].every(name => result.companies[role].includes(name)), "All registered and still restricted companies for " + role);
  }
}
async function create(label, endCompany, upperCompany, sales = owner) {
  return request(sales, "requests", { project: "検証・" + label, summary: "架空案件", upperCompany, endCompany,
    primeCompany: prime, leaderId: "leader-sato", assignmentMode: "direct", studentIds: [person],
    scheduleMode: "availability", candidates: [] });
}

if (process.argv.includes("--persisted")) {
  pastCompanies = [end, upper, prime, ...importedCompanies, extraPartner];
  const shared = { ...saved, all: [manualCompany] };
  const marks = [mark(person, "end", end), mark(person, "upper", upper), mark(person, "all", manualCompany)];
  await expectState(owner, person, shared, { end: [end], upper: [], all: [manualCompany] });
  await expectState(owner, twin, empty);
  await expectState(other, person, shared, { end: [], upper: [upper] });
  await expectLookup(owner, marks);
  await expectLookup(other, marks);
  console.log("PASS: actual Java restart preserved the lookup roster and identical role-specific NG marks across sales.");
  process.exit(0);
}

assert.equal(sql("SELECT count(*) FROM projects;"), "0", "Expected fresh, empty harness DB");
await expectLookup(owner, []);
sql(`INSERT INTO app_users(id,display_name,role) VALUES ('qa-sales','検証営業','sales');
  INSERT INTO app_users(id,display_name,role) SELECT 'qa-student-twin',display_name,'student' FROM app_users WHERE id='student-takahashi';
  INSERT INTO leader_members(leader_id,student_id) VALUES ('leader-sato','qa-student-twin');`);
const first = await create("両区分", end, upper);
await create("区分入れ替え", upper, end);
await create("類似社名", similar, similar);
await create("区分固有", "端島試験社", "上島試験社");
await create("他営業限定", secret, secret, other);
await create("他営業共通", end, upper, other);
sql(`INSERT INTO scheduled_events(id,project_id,request_id,student_id,event_date,start_time,kind,route,format,result)
  SELECT 'qa-prior-result',project_id,id,student_id,'2025-01-10','10:00','meet','直','オンライン','rejected'
  FROM interview_requests WHERE project_id='${first.projectId}' LIMIT 1;`);
assert.equal(sql("SELECT count(*) FROM scheduled_events WHERE id='qa-prior-result' AND result='rejected';"), "1");
pastCompanies = [end, upper, prime];
await expectState(owner, person, empty);
await expectLookup(owner, []);
const available = await request(owner, candidates);
assert.deepEqual(new Set(available.end), new Set((await request(owner, "end-companies")).endCompanies));
for (const role of ["end", "upper"]) {
  assert.deepEqual(new Set(available[role]), new Set([end, upper, similar, secret, role === "end" ? "端島試験社" : "上島試験社"]));
  assert.deepEqual((await request(other, candidates))[role], available[role]);
}
for (const actor of ["leader-sato", person, "admin-initial", null]) {
  const status = actor ? 403 : 401;
  await request(actor, candidates, undefined, status);
  await request(actor, lookup, undefined, status);
  await request(actor, endpoint(person), undefined, status);
  await write("end", end, true, actor, person, status);
}
await request(owner, lookup, {}, 405);
for (const invalidId of ["qa-missing", "leader-sato", owner]) {
  await request(owner, endpoint(invalidId), undefined, "invalid");
  await write("end", end, true, owner, invalidId, "invalid");
}
for (const [role, name, value] of [["end", prime, true], ["upper", prime, true],
  ["end", "上島試験社", true], ["upper", "端島試験社", true], ["prime", prime, true], ["end", "未保存", true],
  ["end", "　", true], ["end", end, "false"]]) {
  await write(role, name, value, owner, person, "invalid");
}
await expectState(owner, person, empty);
await write("end", secret, true);
await expectState(other, person, { end: [secret], upper: [] }, empty);
await write("end", secret, false, other, person, 403);
await expectState(owner, person, { end: [secret], upper: [] });
await write("end", secret, false, owner);
await expectState(owner, person, empty);
const padded = "\u0085\u00a0" + end + "\u3000\ufeff";
await Promise.all(Array.from({length: 5}, (_, idx) => write("end", padded, true, idx % 2 ? other : owner)));
assert.equal(sql("SELECT count(*) FROM interviewer_company_restrictions;"), "2", "Concurrent adds create exactly one registration per owner");
await expectState(owner, person, { end: [end], upper: [] });
await expectState(owner, twin, empty);
await expectState(other, person, { end: [end], upper: [] });
await expectLookup(owner, [mark(person, "end", end)]);
await expectLookup(other, [mark(person, "end", end)]);
await write("end", end, false, other);
await expectState(other, person, { end: [end], upper: [] }, empty);
await expectLookup(other, [mark(person, "end", end)]);
await write("end", end, false, other, person, 403);
await write("upper", end, true);
await expectState(owner, person, { end: [end], upper: [end] });
await write("upper", end, false, owner);
await write("upper", upper, true, other);
await write("end", end, true, owner, twin);
await Promise.all(Array.from({length: 3}, () => write("end", end, false)));
await expectState(owner, person, { end: [], upper: [upper] }, empty);
await expectState(owner, twin, { end: [end], upper: [] });
await expectState(other, person, { end: [], upper: [upper] });
await expectLookup(owner, [mark(twin, "end", end), mark(person, "upper", upper)]);
await expectLookup(other, [mark(twin, "end", end), mark(person, "upper", upper)]);
await write("end", end, false, owner, twin);
await write("end", end, true);
await expectState(owner, person, saved, { end: [end], upper: [] });
sql(`UPDATE projects SET upper_company='QA renamed upper' WHERE upper_company='${upper}';`);
pastCompanies = [end, "QA renamed upper", prime];
assert((await request(owner, candidates)).upper.includes(upper), "An old name still marked NG must be selectable");
await expectLookup(owner, [mark(person, "end", end), mark(person, "upper", upper)]);
await write("upper", upper, false, owner, person, 403);
await write("upper", upper, false, other);
assert(!(await request(other, candidates)).upper.includes(upper), "An upper company with no projects or remaining NG must clear for everyone");
await expectState(owner, person, { end: [end], upper: [] });
await expectLookup(owner, [mark(person, "end", end)]);
await expectState(other, person, { end: [end], upper: [] }, empty);
await write("upper", upper, true, owner, person, "invalid");
await write("upper", upper, false, other);
await create("旧名再使用", end, upper);
sql(`UPDATE projects SET upper_company='${upper}' WHERE id='${first.projectId}';`);
pastCompanies = [end, upper, prime];
await expectState(owner, person, { end: [end], upper: [] });
await write("upper", upper, true, other);
await create("警告承知の指名", end, upper);
// A previously eligible engineer can change roles while a legacy restriction record still exists.
sql(`INSERT INTO app_users(id,display_name,role) VALUES ('qa-role-changed','検証・役割変更','leader');
  INSERT INTO interviewer_company_restrictions(sales_id,student_id,company_role,company_name)
  VALUES ('${owner}','qa-role-changed','upper','旧担当者専用の会社');`);
await expectLookup(owner, [mark(person, "end", end), mark(person, "upper", upper)]);
sql(`
  INSERT INTO projects(id,name,sales_id,upper_company,prime_company,end_company) VALUES
    ('qa-import','取り込み履歴','${owner}','${importedCompanies[0]} → ${extraPartner}','${importedCompanies[1]}','${importedCompanies[2]}'),
    ('qa-excluded','まもなく面談','${owner}','未実施上位','未実施元請','未実施エンド');
  INSERT INTO project_import_history(project_id,student_id,source_row,interview_date,status,source_data)
    VALUES('qa-import','${person}',3,CURRENT_DATE-10,'joined','{}');
  INSERT INTO scheduled_events(id,project_id,student_id,event_date,start_time,kind,route,format,schedule_state) VALUES
    ('qa-upcoming','qa-excluded','${person}',CURRENT_DATE+3,'14:00','meet','直','オンライン','scheduled'),
    ('qa-cancelled','qa-excluded','${person}',CURRENT_DATE-3,'14:00','meet','直','オンライン','cancelled'),
    ('qa-postponed','qa-excluded','${person}',CURRENT_DATE-4,'14:00','meet','直','オンライン','postponed');
`);
pastCompanies.push(...importedCompanies, extraPartner);
await expectState(other, person, saved, { end: [], upper: [upper] });
await expectState(other, twin, empty);
await expectLookup(owner, [mark(person, "end", end), mark(person, "upper", upper)]);
await expectLookup(other, [mark(person, "end", end), mark(person, "upper", upper)]);
await write("all", manualCompany, true, owner, person);
const shared = { ...saved, all: [manualCompany] };
await expectState(owner, person, shared, { end: [end], upper: [], all: [manualCompany] });
await expectState(other, person, shared, { end: [], upper: [upper] });
await write("all", manualCompany, false, other, person, 403);
await write("all", manualCompany, false, owner, person);
await expectState(owner, person, saved, { end: [end], upper: [] });
await write("all", manualCompany, true, owner, person);
await expectLookup(other, [mark(person, "end", end), mark(person, "upper", upper), mark(person, "all", manualCompany)]);
console.log("PASS: all three past interview company roles, imported history, cancelled and upcoming exclusion, and shared lookup.");
console.log("PASS: saved companies, explicit registration, non-blocking assignment, exact role/name, name twins, prior rejection, role boundaries, concurrent cross-sales edits.");
