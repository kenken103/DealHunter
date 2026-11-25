import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A local, disposable test workflow. Only exact account/project identities
// created by this run are removed. Run with --with-frontend to include Next.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".local/accounts-test-state.json");
const apiKey = (await readFile(path.join(root, ".local/api-key"), "utf8")).trim();
const databasePassword = (await readFile(path.join(root, ".local/database.password"), "utf8")).trim();
const backend = "http://127.0.0.1:8080", frontend = "http://127.0.0.1:3100";
const runId = randomUUID(), prefix = `Account verification ${runId}`;
const testPassword = `Fixture-${randomBytes(18).toString("base64url")}`;
const withFrontend = process.argv.includes("--with-frontend");
const tables = ["app_users", "projects", "scheduled_events", "interview_questions", "pending_tasks", "interview_requests", "candidate_slots", "request_attachments", "project_attachments", "interview_feedback", "notification_previews", "task_acknowledgements", "leader_members", "recruitments", "recruitment_candidate_slots", "app_migrations"];
const rowExpression = table => ["request_attachments", "project_attachments"].includes(table)
  ? "(to_jsonb(t)-'content')||jsonb_build_object('contentHash',md5(t.content))"
  : table === "app_users" ? "(to_jsonb(t)-'password_hash')||jsonb_build_object('credentialFingerprint',md5(t.password_hash))" : "to_jsonb(t)";
const snapshotExpression = `jsonb_build_object(${tables.map(table => `'${table}',COALESCE((SELECT jsonb_agg(${rowExpression(table)} ORDER BY to_jsonb(t)::text) FROM ${table} t),'[]'::jsonb)`).join(",")})`;
let users = [], projects = [];

function sql(statement, variables = {}) {
  const executable = process.env.DEALHUNTER_POSTGRES_BIN ? path.join(process.env.DEALHUNTER_POSTGRES_BIN, "psql.exe") : "psql.exe";
  const args = ["-X", "-qAt", "-h", "127.0.0.1", "-p", "15432", "-U", "dealhunter", "-d", "dealhunter", "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(variables)) args.push("-v", `${name}=${value}`);
  args.push("-f", "-");
  const result = spawnSync(executable, args, { cwd: root, input: statement, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000, windowsHide: true, env: { ...process.env, PGPASSWORD: databasePassword, PGCLIENTENCODING: "UTF8" } });
  assert.equal(result.status, 0, "Fixture database operation failed");
  return result.stdout.trim();
}
const snapshot = () => JSON.parse(sql(`SELECT ${snapshotExpression}::text;`));
const unchanged = (before, message) => assert.equal(JSON.stringify(snapshot()), JSON.stringify(before), message);
function noCredentials(value) {
  const serialized = JSON.stringify(value);
  assert(!/password|password_hash|salt|credential/i.test(serialized), "A public account response exposed credential fields");
  assert(!serialized.includes(testPassword), "A public response exposed the fixture password");
}
function trackUser(data, body) {
  if (!data.user?.id || !(body?.name?.startsWith(prefix) || body?.email?.toLowerCase().includes(`dh.verify.${runId}.`))) return;
  const email = body.email.trim().toLowerCase();
  assert(/^[A-Za-z0-9_-]+$/.test(data.user.id), "Unexpected generated account identifier");
  if (!users.some(item => item.id === data.user.id)) users.push({ id: data.user.id, name: body.name, email });
}
function trackProject(data, body) {
  if (!data.projectId || !body?.project?.startsWith(prefix)) return;
  assert(/^DH-[0-9a-f-]{36}$/.test(data.projectId), "Unexpected generated project identifier");
  if (!projects.some(item => item.id === data.projectId)) projects.push({ id: data.projectId, name: body.project });
}
async function request(user, endpoint, body, expected = 200, key = apiKey) {
  const response = await fetch(backend + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(key ? { "X-DealHunter-Key": key } : {}), ...(user ? { "X-DealHunter-User": user } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (endpoint === "/api/auth/register") trackUser(data, body);
  if (endpoint === "/api/requests") trackProject(data, body);
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert(statuses.includes(response.status), `${endpoint}: expected HTTP ${statuses.join("/")}, got ${response.status}`);
  return data;
}
const draft = (label, role = "student", overrides = {}) => ({ name: `${prefix} ${label}`, email: `dh.verify.${runId}.${label}@legarea.jp`, password: testPassword, role, ...overrides });
const register = (label, role = "student", overrides) => request(null, "/api/auth/register", draft(label, role, overrides), [200, 201]);
const login = (email, password = testPassword, expected = 200) => request(null, "/api/auth/login", { email, password }, expected);
const currentUser = id => request(null, `/api/auth/users/${id}`);
const edit = (admin, id, role, leaderId = null, status = 200) => request(admin, `/api/admin/users/${id}`, { role, leaderId }, status);

function cleanup(targetUsers, targetProjects) {
  if (!targetUsers.length && !targetProjects.length) return;
  for (const item of targetUsers) assert(/^[A-Za-z0-9_-]+$/.test(item.id) && (/^Account verification [0-9a-f-]{36} /.test(item.name) || /^dh\.verify\.[0-9a-f-]{36}\.[a-z0-9-]+@legarea\.jp$/.test(item.email)), "Refusing cleanup of an unknown account");
  for (const item of targetProjects) assert(/^DH-[0-9a-f-]{36}$/.test(item.id) && /^Account verification [0-9a-f-]{36} /.test(item.name), "Refusing cleanup of an unknown project");
  sql(`BEGIN;
CREATE TEMP TABLE cleanup_users ON COMMIT DROP AS
SELECT u.id FROM app_users u JOIN jsonb_to_recordset(:'users'::jsonb) AS f(id text,name text,email text)
ON u.id=f.id AND u.display_name=f.name AND u.email=f.email;
SELECT 1/(CASE WHEN count(*)=:'user_count'::integer THEN 1 ELSE 0 END) FROM cleanup_users;
CREATE TEMP TABLE cleanup_projects ON COMMIT DROP AS
SELECT p.id FROM projects p JOIN jsonb_to_recordset(:'projects'::jsonb) AS f(id text,name text)
ON p.id=f.id AND p.name=f.name WHERE p.sales_id IN (SELECT id FROM cleanup_users);
SELECT 1/(CASE WHEN count(*)=:'project_count'::integer THEN 1 ELSE 0 END) FROM cleanup_projects;
DELETE FROM task_acknowledgements WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM notification_previews WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM interview_questions WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM interview_feedback WHERE event_id IN (SELECT id FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_projects));
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_projects) AND kind='entry';
DELETE FROM scheduled_events WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM candidate_slots WHERE request_id IN (SELECT id FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_projects));
DELETE FROM interview_requests WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM recruitments WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM pending_tasks WHERE project_id IN (SELECT id FROM cleanup_projects);
DELETE FROM projects WHERE id IN (SELECT id FROM cleanup_projects);
DELETE FROM leader_members WHERE student_id IN (SELECT id FROM cleanup_users) OR leader_id IN (SELECT id FROM cleanup_users);
DELETE FROM app_users WHERE id IN (SELECT id FROM cleanup_users);
COMMIT;`, { users: JSON.stringify(targetUsers), user_count: targetUsers.length, projects: JSON.stringify(targetProjects), project_count: targetProjects.length });
}

const ownRows = targets => JSON.parse(sql(`SELECT jsonb_build_object(
'users',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM app_users u WHERE u.id IN (SELECT id FROM jsonb_to_recordset(:'users'::jsonb) AS f(id text))),'[]'::jsonb),
'members',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.student_id) FROM leader_members m WHERE m.student_id IN (SELECT id FROM jsonb_to_recordset(:'users'::jsonb) AS f(id text)) OR m.leader_id IN (SELECT id FROM jsonb_to_recordset(:'users'::jsonb) AS f(id text))),'[]'::jsonb)
)::text;`, { users: JSON.stringify(targets) }));

async function frontRequest(endpoint, options = {}) {
  return fetch(frontend + endpoint, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...options });
}
function cookie(response) {
  const header = response.headers.getSetCookie().find(value => value.startsWith("dealhunter_demo_session="));
  assert(header && /;\s*HttpOnly\b/i.test(header) && /;\s*SameSite=lax\b/i.test(header), "Expected a protected signed session cookie");
  return header.split(";", 1)[0];
}
const decode = value => value.replace(/&(?:amp|quot|lt|gt|#39|#x27);/g, entity => ({ "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'" })[entity]);
async function frontLogin(email, password) {
  const page = await frontRequest("/login");
  assert.equal(page.status, 200);
  const html = await page.text();
  const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(match => match[1]).find(markup => /name="email"/.test(markup));
  assert(form, "Expected login server action form");
  const fields = new FormData();
  for (const match of form.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([:\w$-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(part => [part[1], decode(part[2] ?? part[3])]));
    if (attrs.type === "hidden" && attrs.name) fields.append(attrs.name, attrs.value ?? "");
  }
  assert([...fields.keys()].some(name => /^\$ACTION_(ID|REF)_/.test(name)), "Actual login action identifier is missing");
  fields.set("email", email); fields.set("password", password);
  const response = await frontRequest("/login", { method: "POST", headers: { Origin: frontend, Accept: "text/html" }, body: fields });
  assert.equal(response.status, 303, "Login server action should redirect");
  return cookie(response);
}
async function frontMutation(endpoint, body, expected = 200, session) {
  const response = await frontRequest(endpoint, { method: "POST", headers: { Origin: frontend, "Content-Type": "application/json", ...(session ? { Cookie: session } : {}) }, body: JSON.stringify(body) });
  const data = await response.json();
  if (endpoint === "/api/auth/register") trackUser(data, body);
  assert.equal(response.status, expected, `${endpoint}: unexpected Next response status`);
  return { response, data };
}

if (process.argv.includes("--persisted") || process.argv.includes("--cleanup")) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "prepared", "No retained account fixtures exist");
  users = state.users; projects = state.projects;
  try {
    if (!process.argv.includes("--cleanup")) {
      assert.equal(JSON.stringify(ownRows(users)), JSON.stringify(state.expected), "Actual restart changed registered users, passwords, roles or membership");
      for (const user of users) {
        const result = await login(user.email, state.testPassword);
        assert.equal(result.user.id, user.id, "Registered credentials stopped authenticating after restart");
        noCredentials(result);
      }
      console.log("PASS: actual Java restart preserved registered credentials, role changes and team membership.");
    }
  } finally {
    if (!process.argv.includes("--keep")) {
      cleanup(users, projects);
      unchanged(state.baseline, "Pre-existing database rows changed during account verification");
      await writeFile(statePath, JSON.stringify({ phase: "cleaned" }) + "\n", "utf8");
      console.log("PASS: removed only generated accounts/projects and preserved every pre-existing row.");
    }
  }
  process.exit(0);
}

try {
  const retained = JSON.parse(await readFile(statePath, "utf8"));
  assert.notEqual(retained.phase, "prepared", "A retained account test already exists; run --persisted or --cleanup first");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const baseline = snapshot();
let keep = false;
try {
  const adminPassword = (await readFile(path.join(root, ".local/initial-admin-password.txt"), "utf8")).trim();
  const adminLogin = await login("admin@legarea.jp", adminPassword);
  const admin = adminLogin.user.id;
  assert.equal(adminLogin.user.role, "admin", "Bootstrap account is not an administrator");
  noCredentials(adminLogin);
  const invalidEmails = ["person@example.com", "person@evillegarea.jp", "person@legarea.jp.evil", "person@sub.legarea.jp", "person@@legarea.jp", "@legarea.jp", "person @legarea.jp", "a..b@legarea.jp", ".person@legarea.jp", "person.@legarea.jp", "person@legarea.jp\nInjected: value", "person\u0000@legarea.jp"];
  for (const email of invalidEmails) await request(null, "/api/auth/register", draft("invalid-email", "student", { email }), 400);
  for (const overrides of [{ name: "" }, { name: "x".repeat(101) }, { password: "123456789" }, { password: "x".repeat(129) }, { role: "admin" }, { role: "engineer" }, { role: null }]) await request(null, "/api/auth/register", draft("invalid-field", "student", overrides), 400);
  await request(null, "/api/auth/register", draft("missing-key"), 401, null);
  unchanged(baseline, "Invalid/unauthorized registration changed stored records");

  const engineerDraft = draft("engineer");
  let engineer, engineerCookie;
  if (withFrontend) {
    assert.equal((await frontRequest("/register")).status, 200, "Registration page must be available anonymously");
    const rejectedOrigin = await frontRequest("/api/auth/register", { method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: JSON.stringify(engineerDraft) });
    assert.equal(rejectedOrigin.status, 403, "Registration proxy accepted a foreign Origin");
    assert.equal((await frontRequest("/api/admin/users")).status, 401, "Anonymous admin API was allowed");
    const registered = await frontMutation("/api/auth/register", engineerDraft);
    engineer = registered.data.user;
    engineerCookie = cookie(registered.response);
    assert.equal(registered.data.redirectTo, "/engineer");
    noCredentials(registered.data);
  } else engineer = (await register("engineer")).user;
  const leader = (await register("leader", "leader")).user;
  const sales = (await register("sales", "sales")).user;
  const peer = (await register("peer")).user;
  const alternateDraft = draft("alternate-leader", "leader");
  const alternateLeader = (await register("alternate-leader", "leader", { email: `  ${alternateDraft.email.toUpperCase()}  ` })).user;
  for (const user of [engineer, leader, sales, peer, alternateLeader]) {
    assert.equal((await currentUser(user.id)).user.role, user.role);
    noCredentials(await currentUser(user.id));
  }
  const normalized = draft("engineer", "student", { email: `  ${engineerDraft.email.toUpperCase()}  ` });
  await request(null, "/api/auth/register", normalized, 409);
  const caseLogin = await login(`  ${engineerDraft.email.toUpperCase()}  `);
  assert.equal(caseLogin.user.id, engineer.id, "Email case/outer whitespace normalization differs at login");
  await login(engineerDraft.email, testPassword + "wrong", 401);
  await login(`missing.${runId}@legarea.jp`, testPassword, 401);
  const throttledEmail = `throttle.${runId}@legarea.jp`;
  for (let attempt = 0; attempt < 10; attempt++) await login(throttledEmail, testPassword, 401);
  await login(throttledEmail, testPassword, 429);
  const credentials = JSON.parse(sql("SELECT jsonb_agg(jsonb_build_object('id',id,'hash',password_hash) ORDER BY id)::text FROM app_users WHERE id IN (:'first',:'second');", { first: engineer.id, second: peer.id }));
  assert.equal(credentials.length, 2);
  for (const item of credentials) assert(typeof item.hash === "string" && item.hash.length > 64 && !item.hash.includes(testPassword), "Registered password was not stored as a derived hash");
  assert.notEqual(credentials[0].hash, credentials[1].hash, "Identical passwords reused the same salt/hash");

  const directory = await request(admin, "/api/admin/users");
  assert(users.every(user => directory.users.some(item => item.id === user.id)), "Admin directory omitted registered accounts");
  assert.equal(directory.users.find(item => item.id === alternateLeader.id).email, alternateDraft.email, "Registration did not normalize stored email");
  noCredentials(directory);
  for (const user of [engineer, leader, sales]) {
    await request(user.id, "/api/admin/users", undefined, 403);
    await edit(user.id, peer.id, "sales", null, 403);
  }
  await request(null, "/api/admin/users", undefined, 401);
  await edit(admin, engineer.id, "invalid", null, 400);
  await edit(admin, engineer.id, "student", sales.id, 400);
  await edit(admin, engineer.id, "student", engineer.id, 400);
  await edit(admin, engineer.id, "student", "unknown-leader", 400);
  await edit(admin, engineer.id, "student", leader.id);
  assert((await request(leader.id, "/api/dashboard")).teamMembers.some(item => item.id === engineer.id), "Assigned engineer did not appear in the leader team");

  const direct = await request(sales.id, "/api/requests", { project: `${prefix} history`, upperCompany: "Account test upstream", summary: "Role-change history preservation fixture.", studentIds: [engineer.id], leaderId: leader.id, scheduleMode: "availability", candidates: [] });
  assert.equal(direct.requestIds.length, 1);
  const history = sql("SELECT to_jsonb(r)::text FROM interview_requests r WHERE id=:'id';", { id: direct.requestIds[0] });
  if (withFrontend) {
    assert.equal((await frontRequest("/engineer", { headers: { Cookie: engineerCookie } })).status, 200);
    const deniedAdmin = await frontRequest("/api/admin/users", { headers: { Cookie: engineerCookie } });
    if (deniedAdmin.status !== 403) {
      const personal = await frontRequest("/api/dashboard", { headers: { Cookie: engineerCookie } });
      const home = await frontRequest("/engineer", { headers: { Cookie: engineerCookie } });
      console.log(`DIAGNOSTIC: signed engineer admin API=${deniedAdmin.status}, own dashboard=${personal.status}, own page=${home.status}; admin Cache-Control=${deniedAdmin.headers.get("cache-control")}, Age=${deniedAdmin.headers.get("age")}, Next-cache=${deniedAdmin.headers.get("x-nextjs-cache")}.`);
    }
    assert.equal(deniedAdmin.status, 403, "Signed engineer must be forbidden by role rather than treated as anonymous");
  }
  await edit(admin, engineer.id, "leader");
  assert.equal((await currentUser(engineer.id)).user.role, "leader");
  assert(!(await request(leader.id, "/api/dashboard")).teamMembers.some(item => item.id === engineer.id), "Promoted engineer retained active student membership");
  assert.equal(sql("SELECT to_jsonb(r)::text FROM interview_requests r WHERE id=:'id';", { id: direct.requestIds[0] }), history, "Role change modified interview history");
  if (withFrontend) {
    const response = await frontRequest("/engineer", { headers: { Cookie: engineerCookie } });
    assert([303, 307, 308].includes(response.status));
    assert.equal(new URL(response.headers.get("location"), frontend).pathname, "/leader", "Existing session retained the engineer role after promotion");
    await frontMutation(`/api/workflow/requests/${direct.requestIds[0]}/respond`, { proposals: [{ start: "2026-12-10T13:00" }] }, 403, engineerCookie);
  }
  await edit(admin, engineer.id, "sales");
  assert.equal((await currentUser(engineer.id)).user.role, "sales");
  if (withFrontend) {
    const response = await frontRequest("/leader", { headers: { Cookie: engineerCookie } });
    assert.equal(new URL(response.headers.get("location"), frontend).pathname, "/sales", "Existing session retained the leader role after transfer");
    const adminCookie = await frontLogin("admin@legarea.jp", adminPassword);
    assert.equal((await frontRequest("/admin", { headers: { Cookie: adminCookie } })).status, 200);
    await frontMutation(`/api/admin/users/${engineer.id}`, { role: "student", leaderId: alternateLeader.id }, 200, adminCookie);
    assert.equal((await currentUser(engineer.id)).user.role, "student");
    await edit(admin, engineer.id, "sales");
  }

  await edit(admin, peer.id, "student", leader.id);
  await edit(admin, leader.id, "sales", null, 409);
  await edit(admin, peer.id, "student", null);
  const pending = await request(sales.id, "/api/requests", { project: `${prefix} pending`, upperCompany: "Account test upstream", summary: "Pending recruitment role guard fixture.", assignmentMode: "leader", leaderId: leader.id, studentIds: [], scheduleMode: "availability", candidates: [] });
  await edit(admin, leader.id, "sales", null, 409);
  await edit(admin, peer.id, "student", leader.id);
  await request(leader.id, `/api/recruitments/${pending.recruitmentId}/assign`, { studentIds: [peer.id] });
  await edit(admin, peer.id, "student", null);
  await edit(admin, leader.id, "sales");
  await edit(admin, engineer.id, "admin");
  assert.equal((await request(engineer.id, "/api/admin/users")).users.find(item => item.id === engineer.id).role, "admin");
  await edit(engineer.id, engineer.id, "sales");
  await request(engineer.id, "/api/admin/users", undefined, 403);

  if (process.argv.includes("--prepare")) {
    await writeFile(statePath, JSON.stringify({ phase: "prepared", users, projects, testPassword, baseline, expected: ownRows(users) }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    keep = true;
  }
  console.log(`PASS: exact-domain registration, password storage/login, duplicate email rejection, admin-only editing, role/team changes, preserved interview history${withFrontend ? ", Next registration/admin proxies and current roles in existing signed sessions" : ""}.`);
  console.log("NOTE: last-administrator protection is reviewed statically; this test never demotes pre-existing administrators.");
} finally {
  if (!keep) {
    cleanup(users, projects);
    unchanged(baseline, "Pre-existing database rows changed during account verification");
    console.log("PASS: removed only generated accounts/projects and preserved every pre-existing row.");
  }
}
