import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run through scripts/verify-end-companies.ps1. This verifier intentionally has
// no production defaults and refuses the application's normal ports/database.
const api = process.env.DEALHUNTER_END_TEST_API;
const pgPort = process.env.DEALHUNTER_END_TEST_PGPORT;
const testRoot = process.env.DEALHUNTER_END_TEST_ROOT;
const psql = process.env.DEALHUNTER_END_TEST_PSQL;
assert(api && /^http:\/\/127\.0\.0\.1:\d+$/.test(api) && new URL(api).port !== "8080", "An isolated test API is required");
assert(pgPort && /^\d+$/.test(pgPort) && pgPort !== "15432", "An isolated test PostgreSQL port is required");
assert(testRoot && psql, "Use the isolated PowerShell harness");
assert.equal((await readFile(path.join(testRoot, ".dealhunter-end-company-test"), "utf8")).trim(), "dealhunter_end_companies_test");
const key = (await readFile(path.join(testRoot, "api-key"), "utf8")).trim();
const statePath = path.join(testRoot, "verification-state.json");
const sales = "sales-aoki", otherSales = "test-sales-other", admin = "admin-initial";
const student = "student-takahashi", leader = "leader-sato";
const prefix = "EndCompany isolated";

function sql(statement, variables = {}) {
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", pgPort, "-U", "dealhunter", "-d", "dealhunter_end_companies_test", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(psql, args, { input: statement, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, `Isolated fixture SQL failed: ${result.stderr || result.error || "unknown error"}`);
  return result.stdout.trim();
}
const legacyRaw = "\u00a0\u3000既存 エンド株式会社 \ufeff";
const longRaw = "　" + Array.from({ length: 1800 }, (_, n) => String.fromCodePoint(0x4e00 + n)).join("") + "　";
if (process.argv.includes("--seed-legacy")) {
  assert.equal(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';"), "0", "Legacy fixtures need an empty test database");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const oldSql = name => execFileSync("git", ["show", "ee48a16:backend/" + name], { cwd: root, encoding: "utf8", windowsHide: true });
  sql(oldSql("schema.sql"));
  sql(oldSql("seed-users.sql"));
  assert.equal(sql("SELECT to_regclass('project_end_companies') IS NULL;"), "t");
  sql(`INSERT INTO app_users(id,display_name,role) VALUES('test-sales-other','別担当営業テスト','sales');
    INSERT INTO projects(id,name,sales_id,notes,end_company,upper_company,leader_id) VALUES
    ('test-legacy-own','既存案件テスト','sales-aoki','既存履歴保持',convert_from(decode(:'legacy','hex'),'UTF8'),'既存上位会社','leader-sato'),
    ('test-legacy-other','別営業案件テスト','test-sales-other','','別営業限定株式会社','別営業上位会社','leader-suzuki'),
    ('test-legacy-whitespace','空白だけの旧案件','sales-aoki','',E'\\t　','','leader-sato'),
    ('test-legacy-long','旧長文案件','test-sales-other','',convert_from(decode(:'longName','hex'),'UTF8'),'','leader-suzuki'),
    ('test-legacy-visible','移行前の販売管理案件','sales-aoki','移行前の面談依頼','旧登録エンド商事','旧登録上位企業','leader-sato');
    INSERT INTO interview_requests(id,project_id,student_id,status,schedule_mode) VALUES
    ('test-legacy-visible-request','test-legacy-visible','student-takahashi','requested','availability');`, { legacy: Buffer.from(legacyRaw).toString("hex"), longName: Buffer.from(longRaw).toString("hex") });
  console.log("PASS: seeded five projects and an interview request on the original ee48a16 schema before Java starts; no company history table exists yet.");
  process.exit(0);
}
const tables = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").split(/\r?\n/);
assert(tables.every(table => /^[a-z_]+$/.test(table)), "Unexpected test schema table");
function snapshot() {
  return sql(`SELECT jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})::text;`);
}
async function request(user, endpoint, body, expected = 200, apiKey = key) {
  if (body && user === "admin-initial" && endpoint.startsWith("admin/projects/")) {
    const id = endpoint.split("/").at(-1);
    body = { ...body, revision: Number(sql("SELECT edit_revision FROM projects WHERE id=:'projectId';", { projectId: id })) };
  }
  const response = await fetch(`${api}/api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DealHunter-Key": apiKey, ...(user ? { "X-DealHunter-User": user } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${endpoint}: HTTP ${response.status}, expected ${expected}: ${result.error ?? "unexpected response"}`);
  return result;
}
const dashboard = user => request(user, "dashboard");
async function candidates(user = sales) {
  const result = await request(user, "end-companies");
  assert(Array.isArray(result.endCompanies) && result.endCompanies.every(name => typeof name === "string" && name.length > 0), "Candidates must be nonempty company names");
  assert.equal(new Set(result.endCompanies.map(name => name.normalize("NFKC"))).size, result.endCompanies.length, "Equivalent character widths must appear once in candidates");
  return result.endCompanies;
}
const draft = (label, overrides = {}) => ({ project: `${prefix} ${label}`, summary: "Synthetic company selection verification", upperCompany: "上位会社テスト", leaderId: leader, assignmentMode: "direct", studentIds: [student], scheduleMode: "availability", candidates: [], ...overrides });
const create = (label, overrides = {}, actor = sales) => request(actor, "requests", draft(label, overrides));
const project = async id => (await dashboard(sales)).projects.find(item => item.id === id);
const savedHistory = () => sql("SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.project_id,h.name),'[]'::jsonb)::text FROM project_end_companies h;");

if (process.argv.includes("--persisted")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(await candidates(sales), state.salesCandidates, "Actual Java restart changed sales candidates");
  assert.deepEqual(await candidates(otherSales), state.otherCandidates, "Actual Java restart changed candidate scope");
  assert.deepEqual(await candidates(admin), state.adminCandidates, "Actual Java restart changed admin candidates");
  assert.equal(savedHistory(), state.history, "Actual Java restart changed saved company history");
  for (const item of state.projects) assert.equal((await project(item.id)).endCompany, item.endCompany, "Actual Java restart changed project company name");
  console.log("PASS: actual isolated Java restart retained company history, names and shared sales candidates.");
  process.exit(0);
}

const legacyCompanies = new Set(["既存 エンド株式会社", "旧登録エンド商事", "別営業限定株式会社", longRaw.trim()]);
assert.deepEqual(new Set(await candidates()), legacyCompanies, "Pre-upgrade projects across sales must appear on first read");
assert.equal((await dashboard(sales)).requests.find(r => r.id === "test-legacy-visible-request").endCompany, "旧登録エンド商事");
assert.equal((await project("test-legacy-own")).endCompany, legacyRaw);
assert.deepEqual(new Set(await candidates(otherSales)), legacyCompanies);
await request(admin, "admin/projects/test-legacy-long", { name: "旧長文案件改題", endCompany: longRaw });
assert.equal((await dashboard(otherSales)).projects.find(p => p.id === "test-legacy-long").endCompany, longRaw);
await request(admin, "admin/projects/test-legacy-long", { endCompany: "置換後の旧長文企業" });
assert((await candidates(otherSales)).includes(longRaw.trim()), "Large pre-upgrade names must survive edits without index failures");
assert((await candidates(admin)).includes("別営業限定株式会社"));
for (const actor of [student, leader]) await request(actor, "end-companies", undefined, 403);
await request(null, "end-companies", undefined, 401);
await request(sales, "end-companies", undefined, 401, "incorrect-test-key");
await request(sales, "end-companies", { name: "取消された会社" }, 405);
console.log("PASS: shared legacy candidates, Unicode edge trimming, read-only endpoint and authorized roles.");

const beforeCancel = snapshot();
// Reviewing, returning and cancelling are frontend-only; candidate reads perform no writes.
await candidates(); await candidates();
assert.equal(snapshot(), beforeCancel, "Opening/reading candidates must not persist a draft company");
const newName = "新規エンド株式会社";
const first = await create("new", { endCompany: `\u0085\ufeff\u00a0 ${newName}\u3000\n` });
assert.equal((await project(first.projectId)).endCompany, newName);
assert((await candidates()).includes(newName), "A saved new company must be selectable for the next case");
const next = await create("selected-next", { endCompany: (await candidates()).find(name => name === newName) });
assert.equal((await project(next.projectId)).endCompany, newName);
await Promise.all(["duplicate-1", "duplicate-2"].map(label => create(label, { endCompany: `　${newName} ` })));
assert.equal((await candidates()).filter(name => name === newName).length, 1);
const companySpellings = ["ＡＣＭＥ", "ACME", "Acme", "AC ME", "Acme株式会社", "Acme 株式会社", "ＡＣＭＥ（東京）"];
for (const name of companySpellings) {
  const created = await create(name, { upperCompany: name, endCompany: name });
  const saved = await project(created.projectId);
  assert.equal(saved.upperCompany, name);
  assert.equal(saved.endCompany, name);
}
for (const role of ["upper", "end"]) {
  const names = (await request(sales, "interviewer-company-candidates"))[role];
  for (const name of companySpellings) assert.equal(names.filter(candidate => candidate.normalize("NFKC") === name.normalize("NFKC")).length, 1);
}
const markRoute = "interviewer-company-restrictions/" + student;
await request(sales, markRoute, { companyRole: "upper", companyName: "ＡＣＭＥ", restricted: true });
await request(sales, markRoute, { companyRole: "upper", companyName: "ACME", restricted: true });
assert.deepEqual((await request(sales, markRoute)).ownRestrictions.upper, ["ＡＣＭＥ"]);
await request(sales, markRoute, { companyRole: "upper", companyName: "ACME", restricted: false });
assert.deepEqual((await request(sales, markRoute)).ownRestrictions.upper, []);
const beforeEmpty = await candidates();
for (const [label, override] of [["omitted", {}], ["empty", { endCompany: "" }], ["whitespace", { endCompany: "\u0085\u00a0\u3000\ufeff" }]]) {
  const result = await create(label, override);
  assert.equal((await project(result.projectId)).endCompany, "", "Company remains optional");
}
assert.deepEqual(await candidates(), beforeEmpty, "Blank cases must not create blank companies");
const leaderDraft = await create("leader", { assignmentMode: "leader", studentIds: [], endCompany: newName });
assert.equal((await dashboard(sales)).recruitments.find(item => item.id === leaderDraft.recruitmentId).endCompany, newName);
const legacyStudent = draft("legacy-student", { endCompany: "旧形式テスト会社", studentId: student });
delete legacyStudent.studentIds;
await request(sales, "requests", legacyStudent);
console.log("PASS: new save/reload/next selection, concurrent exact duplicates, similar separate names, optional blank and both assignment modes.");

for (const invalid of [{ endCompany: null }, { endCompany: 7 }, { endCompany: "長".repeat(201) }, { studentIds: ["missing-test-student"], endCompany: "保存失敗会社" }]) {
  const before = snapshot();
  await request(sales, "requests", draft("invalid", invalid), 400);
  assert.equal(snapshot(), before, "Failed validation must not leave project/company records");
}
sql(`CREATE FUNCTION test_reject_interview_insert() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'synthetic later-write rollback verification'; END $$;
 CREATE TRIGGER test_reject_interview_insert BEFORE INSERT ON interview_requests FOR EACH ROW EXECUTE FUNCTION test_reject_interview_insert();`);
try {
  const before = snapshot();
  await request(sales, "requests", draft("late-rollback", { endCompany: "後続失敗ロールバック会社" }), 503);
  assert.equal(snapshot(), before, "A later transaction failure must roll back project and saved company together");
} finally { sql("DROP TRIGGER test_reject_interview_insert ON interview_requests; DROP FUNCTION test_reject_interview_insert();"); }
assert(!(await candidates()).includes("後続失敗ロールバック会社"));
console.log("PASS: invalid values and injected later-write failure leave no project/company orphans.");

await request(admin, "admin/projects/test-legacy-own", { name: "既存案件別項目編集テスト", endCompany: legacyRaw });
assert.equal((await project("test-legacy-own")).endCompany, legacyRaw, "Editing other fields must preserve an exact raw legacy name");
const changedName = "管理編集後ＡＢＣ株式会社";
await request(admin, `admin/projects/${first.projectId}`, { endCompany: `　${changedName} ` });
assert.equal((await project(first.projectId)).endCompany, changedName);
await request(admin, `admin/projects/${first.projectId}`, { endCompany: "" });
assert.equal((await project(first.projectId)).endCompany, "");
assert((await candidates()).includes(changedName), "Clearing/changing a project must retain its previously saved company candidates");
await request(admin, "admin/projects/test-legacy-own", { endCompany: changedName });
assert((await candidates()).includes("既存 エンド株式会社"), "Changed legacy names must be retained in history");
const beforeBadEdit = snapshot();
await request(admin, `admin/projects/${first.projectId}`, { endCompany: "失敗した管理編集会社", name: "" }, 400);
assert.equal(snapshot(), beforeBadEdit, "Failed admin edit must not archive a new company");
await request(sales, `admin/projects/${first.projectId}`, { endCompany: "権限なしの編集会社" }, 403);
const otherCase = await create("other-sales", { endCompany: "他営業新規保存会社" }, otherSales);
assert((await candidates(sales)).includes("他営業新規保存会社"));
assert((await dashboard(sales)).projects.some(item => item.id === otherCase.projectId), "Sales can view another sales user's project");
assert((await candidates(otherSales)).includes(changedName));
assert((await candidates(admin)).includes("他営業新規保存会社"));
console.log("PASS: admin edits preserve raw names and company history; names from newly saved projects are shared across sales.");

// Exercise the unchanged scheduling/history projections with a selected company.
await request(student, `requests/${next.requestId}/respond`, { proposals: [{ start: "2030-01-21T13:00" }] });
let data = await dashboard(sales);
const assigned = data.requests.find(item => item.id === next.requestId);
assert.equal(assigned.endCompany, newName);
const confirmed = await request(sales, `requests/${next.requestId}/confirm`, { slotId: assigned.availableSlotIds[0], url: "https://meet.example/end-company-test" });
data = await dashboard(sales);
assert.equal(data.events.find(item => item.key === confirmed.eventId).endCompany, newName);
assert.equal((await dashboard(student)).events.find(item => item.key === confirmed.eventId).endCompany, newName);
assert(!(await dashboard("student-inoue")).projects.some(item => item.id === next.projectId));
assert.equal((await dashboard(leader)).projects.find(item => item.id === next.projectId).endCompany, newName);
console.log("PASS: selected company remains in request/interview history and original viewer visibility.");

if (process.argv.includes("--browser-fixture")) {
  // A deterministic late failure for the browser save/return test in this disposable DB.
  sql(`CREATE FUNCTION test_browser_request_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT name FROM projects WHERE id=NEW.project_id)='UI-rollback-only' THEN
        RAISE EXCEPTION 'browser fixture: later request write failed';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_browser_request_failure BEFORE INSERT ON interview_requests FOR EACH ROW EXECUTE FUNCTION test_browser_request_failure();`);
}

const projects = (await dashboard(sales)).projects.map(({ id, endCompany }) => ({ id, endCompany }));
await writeFile(statePath, JSON.stringify({ salesCandidates: await candidates(sales), otherCandidates: await candidates(otherSales), adminCandidates: await candidates(admin), history: savedHistory(), projects }, null, 2) + "\n", "utf8");
console.log("PASS: isolated fixtures prepared for actual Java restart verification.");
