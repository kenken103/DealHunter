import assert from "node:assert/strict";

const origin = "http://127.0.0.1:3100";
const emptyMode = process.argv.includes("--empty");
const engineerAliases = ["takahashi", "yamamoto", "mori", "ito", "kobayashi", "sasaki", "tanaka", "kimura", "inoue"];
const request = (pathname, options = {}) => fetch(new URL(pathname, origin), {
  redirect: "manual",
  signal: AbortSignal.timeout(10000),
  ...options,
});
const location = response => new URL(response.headers.get("location") ?? "", origin);
const decode = value => value.replace(/&(?:amp|quot|lt|gt|#39|#x27);/g, entity => ({
  "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'",
})[entity]);

function attributes(markup) {
  return Object.fromEntries([...markup.matchAll(/([:\w$-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1], decode(match[2] ?? match[3])]));
}

function actionFields(html, predicate, label) {
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(match => match[1]);
  const form = forms.find(predicate);
  assert.ok(form, `Expected ${label} server-action form was not rendered (${forms.length} forms found)`);
  const inputs = [...form.matchAll(/<input\b([^>]*)>/g)].map(match => attributes(match[1]));
  // React's rendered native forms use multipart; Next.js 16 rejects URL-encoded actions.
  const fields = new FormData();
  for (const input of inputs.filter(input => input.type === "hidden" && input.name)) fields.append(input.name, input.value ?? "");
  assert.ok([...fields.keys()].some(name => /^\$ACTION_(ID|REF)_/.test(name)), "Missing actual server-action identifier");
  return fields;
}

async function expectRedirect(pathname, destination, cookie) {
  const response = await request(pathname, { headers: cookie ? { Cookie: cookie } : {} });
  assert.ok([303, 307, 308].includes(response.status), `${pathname} should redirect`);
  assert.equal(location(response).pathname, destination, `Unexpected redirect for ${pathname}`);
  return response;
}

async function login(email, password, next) {
  const loginPath = "/login" + (next === undefined ? "" : `?${new URLSearchParams({ next })}`);
  const page = await request(loginPath);
  assert.equal(page.status, 200, "Login page must be available without authentication");
  const fields = actionFields(await page.text(), form => /name="email"/.test(form), "login");
  fields.set("email", email);
  fields.set("password", password);
  if (next !== undefined) {
    assert.equal(fields.get("next"), next, "Login form must preserve the requested return path");
    fields.set("next", next);
  }
  return request(loginPath, {
    method: "POST",
    headers: { Origin: origin, Accept: "text/html" },
    body: fields,
  });
}

function sessionCookie(response) {
  const header = response.headers.getSetCookie().find(value => value.startsWith("dealhunter_demo_session="));
  assert.ok(header, "Successful login must set a session cookie");
  assert.match(header, /;\s*HttpOnly\b/i, "Session must be HttpOnly");
  assert.match(header, /;\s*SameSite=lax\b/i, "Session must use SameSite=Lax");
  assert.match(header, /;\s*Path=\//i, "Session must cover protected routes");
  assert.match(header, /;\s*Max-Age=28800\b/i, "Session must have an eight-hour lifetime");
  return header.split(";", 1)[0];
}

function verifyEntryHistory(data, viewer) {
  assert.ok(data.events.every(event => Object.hasOwn(event, "parentEventId")), `${viewer}: dashboard must expose initial-entry parent references`);
  const linkedEntries = data.events.filter(event => event.entry && event.parentEventId);
  for (const entry of linkedEntries) {
    const interview = data.events.find(event => event.key === entry.parentEventId);
    assert.ok(interview, `${viewer}: initial-entry source interview must be available to the same viewer`);
    assert.equal(interview.entry, false, `${viewer}: entry parent must be an interview`);
    assert.equal(interview.projectId, entry.projectId, `${viewer}: entry and source interview must refer to the same project`);
    assert.equal(interview.studentId, entry.studentId, `${viewer}: entry and source interview must refer to the same engineer`);
    assert.equal(entry.notes, interview.notes, `${viewer}: initial-entry registration must retain the original project overview`);
  }
  return linkedEntries.length;
}

function verifyCaseCollections(data, viewer) {
  for (const collection of ["projects", "events", "questions", "tasks", "requests", "feedbacks", "notifications"]) {
    assert.ok(Array.isArray(data[collection]), `${viewer}: ${collection} must be an array`);
    if (emptyMode) assert.equal(data[collection].length, 0, `${viewer}: ${collection} must be empty after the case-data reset`);
  }
  assert.ok(Array.isArray(data.leaders), `${viewer}: leader directory must be an array`);
  for (const project of data.projects) {
    assert.ok(project.leaderId === null || typeof project.leaderId === "string", `${viewer}: project leader must be nullable`);
  }
  for (const record of [...data.projects, ...data.requests, ...data.events]) {
    assert.equal(typeof record.participantName, "string", `${viewer}: participant name must be independent text`);
    assert.equal(typeof record.participantNameKana, "string", `${viewer}: participant kana must be text`);
  }
  for (const item of data.requests) {
    if (!item.attachment) continue;
    assert.ok(["project", "request"].includes(item.attachment.scope), `${viewer}: attachment must identify shared or legacy scope`);
    assert.ok(typeof item.attachment.name === "string" && item.attachment.size > 0, `${viewer}: attachment metadata must include name and size`);
  }
  if (emptyMode) {
    assert.equal(data.requests.flatMap(item => item.candidates).length, 0, `${viewer}: no candidate slots should remain`);
  }
  for (const event of data.events) {
    assert.ok(event.engineerConfirmedAt === null || typeof event.engineerConfirmedAt === "string", `${viewer}: engineer schedule confirmation must be null or a timestamp string`);
  }
  for (const task of data.tasks) {
    assert.ok(typeof task.projectId === "string" && task.projectId.length > 0, `${viewer}: each task must identify its project`);
    assert.ok(Number.isInteger(task.revision) && task.revision > 0, `${viewer}: task revision must be a positive integer`);
    assert.equal(typeof task.unread, "boolean", `${viewer}: task unread state must be boolean`);
    assert.ok(task.acknowledgedAt === null || typeof task.acknowledgedAt === "string", `${viewer}: task acknowledgment must be null or a timestamp string`);
    assert.equal(task.unread, task.acknowledgedAt === null, `${viewer}: stale or missing acknowledgment must be unread`);
  }
}

try {
  for (const pathname of ["/", "/sales", "/engineer", "/leader"]) await expectRedirect(pathname, "/login");
  assert.equal((await request("/api/dashboard")).status, 401, "Anonymous dashboard API must be denied");
  assert.equal((await request("/api/requests/nonexistent/attachment")).status, 401, "Anonymous attachment download must be denied");
  assert.equal((await request("/api/workflow/requests/nonexistent/attachment", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 401, "Anonymous attachment upload must be denied");
  const anonymousAcknowledgment = await request("/api/workflow/tasks/nonexistent/acknowledge", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1 }) });
  assert.equal(anonymousAcknowledgment.status, 401, "Anonymous users must not acknowledge tasks");
  const anonymousEventAcknowledgment = await request("/api/workflow/events/nonexistent/acknowledge", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(anonymousEventAcknowledgment.status, 401, "Anonymous users must not confirm an engineer's schedule");

  const invalid = await login("sales.aoki@dealhunter.example", "wrong-password");
  assert.equal(invalid.status, 303, "Invalid login must redirect back to login");
  assert.equal(location(invalid).pathname, "/login");
  assert.equal(location(invalid).searchParams.get("error"), "invalid");
  assert.ok(!invalid.headers.getSetCookie().some(value => value.startsWith("dealhunter_demo_session=")), "Invalid credentials must not create a session");

  const salesLogin = await login("sales.aoki@dealhunter.example", "demo-sales");
  assert.equal(salesLogin.status, 303);
  assert.equal(location(salesLogin).pathname, "/sales");
  const sales = sessionCookie(salesLogin);
  await expectRedirect("/", "/sales", sales);
  await expectRedirect("/login", "/sales", sales);
  await expectRedirect("/engineer", "/sales", sales);
  await expectRedirect("/leader", "/sales", sales);
  const dashboard = await request("/api/dashboard", { headers: { Cookie: sales } });
  assert.equal(dashboard.status, 200, "Sales account should read its dashboard");
  const salesData = await dashboard.json();
  verifyCaseCollections(salesData, "sales");
  const salesEventAcknowledgment = await request("/api/workflow/events/nonexistent/acknowledge", { method: "POST", headers: { Cookie: sales, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(salesEventAcknowledgment.status, 403, "Sales must not confirm a schedule on behalf of an engineer");
  const linkedEntryCount = verifyEntryHistory(salesData, "sales");
  assert.deepEqual(salesData.students.map(student => student.id).sort(), engineerAliases.map(alias => `student-${alias}`).sort(), "Sales must see all nine registered demo engineers");
  assert.deepEqual(salesData.leaders.map(leader => leader.id).sort(), ["leader-sato", "leader-suzuki"], "Sales must see the registered leader directory");
  assert.equal((await request("/sales", { headers: { Cookie: sales } })).status, 200, "Sales session should survive a page refresh");

  const engineerTarget = "/engineer?event=DH-1027";
  // Return-path syntax can be tested without creating any case data.
  const salesTarget = `/sales?${new URLSearchParams({ request: salesData.requests[0]?.id ?? "R-RETURN-PATH-CHECK" })}`;
  const leaderTarget = "/leader?project=DH-RETURN-PATH-CHECK";
  for (const target of [engineerTarget, salesTarget, leaderTarget]) {
    const anonymousLink = await expectRedirect(target, "/login");
    assert.equal(location(anonymousLink).searchParams.get("next"), target, "Anonymous notification link must survive the login redirect");
  }
  const invalidDeepLink = await login("engineer.takahashi@dealhunter.example", "wrong-password", engineerTarget);
  assert.equal(invalidDeepLink.status, 303);
  assert.equal(location(invalidDeepLink).pathname, "/login");
  assert.equal(location(invalidDeepLink).searchParams.get("error"), "invalid");
  assert.equal(location(invalidDeepLink).searchParams.get("next"), engineerTarget, "Invalid credentials must retain the notification return path");

  for (const [email, password, next, expected] of [
    ["engineer.takahashi@dealhunter.example", "demo-engineer", engineerTarget, engineerTarget],
    ["sales.aoki@dealhunter.example", "demo-sales", salesTarget, salesTarget],
    ["engineer.takahashi@dealhunter.example", "demo-engineer", "/engineer?event=DH-1027&ignored=discard#fragment", engineerTarget],
    ["sales.aoki@dealhunter.example", "demo-sales", "https://untrusted.example/sales?request=R-DEMO", "/sales"],
    ["engineer.takahashi@dealhunter.example", "demo-engineer", "//untrusted.example/engineer", "/engineer"],
    ["engineer.takahashi@dealhunter.example", "demo-engineer", salesTarget, "/engineer"],
    ["sales.aoki@dealhunter.example", "demo-sales", engineerTarget, "/sales"],
    ["engineer.takahashi@dealhunter.example", "demo-engineer", "/engineer?event=invalid%2Fidentifier", "/engineer"],
    ["leader.sato@dealhunter.example", "demo-leader", "/leader?project=DH-RETURN-PATH-CHECK&event=discard#fragment", leaderTarget],
    ["leader.sato@dealhunter.example", "demo-leader", salesTarget, "/leader"],
    ["leader.sato@dealhunter.example", "demo-leader", "https://untrusted.example/leader?project=DH-CHECK", "/leader"],
    ["sales.aoki@dealhunter.example", "demo-sales", leaderTarget, "/sales"],
  ]) {
    const linkedLogin = await login(email, password, next);
    assert.equal(linkedLogin.status, 303, "Return-path login must succeed");
    assert.equal(location(linkedLogin).origin, origin, "Login return path must remain on this application");
    assert.equal(location(linkedLogin).pathname + location(linkedLogin).search, expected, "Login must retain only a valid, same-role notification destination");
    assert.equal(location(linkedLogin).hash, "", "Login return path must discard fragments");
  }

  const engineerLogin = await login("engineer.takahashi@dealhunter.example", "demo-engineer");
  assert.equal(engineerLogin.status, 303);
  assert.equal(location(engineerLogin).pathname, "/engineer");
  const engineer = sessionCookie(engineerLogin);
  await expectRedirect("/", "/engineer", engineer);
  await expectRedirect("/login", "/engineer", engineer);
  await expectRedirect("/sales", "/engineer", engineer);
  await expectRedirect("/leader", "/engineer", engineer);
  assert.equal((await request("/engineer", { headers: { Cookie: engineer } })).status, 200);
  const ownDashboard = await request("/api/dashboard", { headers: { Cookie: engineer } });
  assert.equal(ownDashboard.status, 200, "Engineer must read its own dashboard");
  const ownData = await ownDashboard.json();
  verifyCaseCollections(ownData, "takahashi");
  assert.ok(ownData.events.every(event => event.studentId === "student-takahashi"), "Engineer must not read another student's events");
  assert.ok(ownData.requests.every(item => item.studentId === "student-takahashi"), "Engineer must not read another student's requests");
  assert.ok(ownData.feedbacks.every(item => item.studentId === "student-takahashi"), "Engineer must not read another student's feedback");
  const anotherEngineerEvent = salesData.events.find(event => event.studentId !== "student-takahashi");
  if (anotherEngineerEvent) {
    // Only a different engineer's event is targeted; the ownership guard must reject before any write.
    const otherEventAcknowledgment = await request(`/api/workflow/events/${encodeURIComponent(anotherEngineerEvent.key)}/acknowledge`, { method: "POST", headers: { Cookie: engineer, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(otherEventAcknowledgment.status, 403, "Engineer must not confirm another engineer's schedule");
  }
  const forgedIdentity = await request("/api/dashboard", { headers: { Cookie: engineer, "X-DealHunter-User": "sales-aoki", "X-DealHunter-Key": "forged" } });
  assert.equal(forgedIdentity.status, 200);
  assert.ok((await forgedIdentity.json()).events.every(item => item.studentId === "student-takahashi"), "Client headers must not override the signed-in identity");
  const wrongRole = await request("/api/workflow/requests", { method: "POST", headers: { Cookie: engineer, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(wrongRole.status, 403, "Engineer must not create a sales request");
  assert.equal((await request("/api/workflow/requests/nonexistent/attachment", { method: "POST", headers: { Cookie: engineer, Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 403, "Engineer must not upload an attachment");
  const engineerAcknowledgment = await request("/api/workflow/tasks/nonexistent/acknowledge", { method: "POST", headers: { Cookie: engineer, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1 }) });
  assert.equal(engineerAcknowledgment.status, 403, "Engineer must not acknowledge a sales task");
  const foreignOrigin = await request("/api/workflow/requests", { method: "POST", headers: { Cookie: sales, Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(foreignOrigin.status, 403, "Cross-origin mutation must be denied");
  assert.equal((await request("/api/workflow/requests/nonexistent/attachment", { method: "POST", headers: { Cookie: sales, Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: "{}" })).status, 403, "Cross-origin attachment upload must be denied");

  for (const alias of engineerAliases) {
    const expectedId = `student-${alias}`;
    const accountLogin = await login(`engineer.${alias}@dealhunter.example`, "demo-engineer");
    assert.equal(accountLogin.status, 303, `${alias}: engineer login must succeed`);
    assert.equal(location(accountLogin).pathname, "/engineer", `${alias}: login must open the engineer home`);
    const accountCookie = sessionCookie(accountLogin);
    const accountDashboard = await request("/api/dashboard", { headers: { Cookie: accountCookie } });
    assert.equal(accountDashboard.status, 200, `${alias}: own dashboard must be available`);
    const accountData = await accountDashboard.json();
    verifyCaseCollections(accountData, alias);
    assert.equal(accountData.currentUser.id, expectedId, `${alias}: dashboard must identify the signed-in engineer`);
    assert.equal(accountData.currentUser.role, "student", `${alias}: dashboard must retain the engineer role`);
    assert.deepEqual(accountData.students.map(student => student.id), [expectedId], `${alias}: student directory must contain only self`);
    assert.deepEqual(accountData.leaders, [], `${alias}: students must not receive the leader directory`);
    for (const collection of ["events", "requests", "feedbacks"]) {
      assert.ok(Array.isArray(accountData[collection]), `${alias}: ${collection} must be an array`);
      assert.ok(accountData[collection].every(item => item.studentId === expectedId), `${alias}: ${collection} must not include another engineer's data`);
    }
    verifyEntryHistory(accountData, alias);
  }

  for (const alias of ["sato", "suzuki"]) {
    const expectedId = `leader-${alias}`;
    const leaderLogin = await login(`leader.${alias}@dealhunter.example`, "demo-leader");
    assert.equal(leaderLogin.status, 303);
    assert.equal(location(leaderLogin).pathname, "/leader", "Leader must open the leader home");
    const leaderCookie = sessionCookie(leaderLogin);
    await expectRedirect("/", "/leader", leaderCookie);
    await expectRedirect("/sales", "/leader", leaderCookie);
    await expectRedirect("/engineer", "/leader", leaderCookie);
    assert.equal((await request("/leader", { headers: { Cookie: leaderCookie } })).status, 200);
    const leaderResponse = await request("/api/dashboard", { headers: { Cookie: leaderCookie } });
    assert.equal(leaderResponse.status, 200);
    const leaderData = await leaderResponse.json();
    verifyCaseCollections(leaderData, expectedId);
    verifyEntryHistory(leaderData, expectedId);
    assert.equal(leaderData.currentUser.id, expectedId);
    assert.equal(leaderData.currentUser.role, "leader");
    assert.deepEqual(leaderData.leaders, [], "Leaders must not receive a global leader directory");
    assert.ok(leaderData.projects.every(project => project.leaderId === expectedId), "Leader must see only explicitly assigned projects");
    const projectIds = new Set(leaderData.projects.map(project => project.id));
    for (const collection of ["events", "requests", "feedbacks", "tasks"]) {
      assert.ok(leaderData[collection].every(item => projectIds.has(item.projectId)), `Leader ${collection} must stay within assigned projects`);
    }
    assert.ok(leaderData.questions.every(item => projectIds.has(item.project)), "Leader questions must stay within assigned projects");
    const memberIds = new Set([...leaderData.requests, ...leaderData.events].map(item => item.studentId));
    assert.ok(leaderData.students.every(student => memberIds.has(student.id)), "Leader directory must contain only assigned project members");
    assert.equal((await request("/api/requests/nonexistent/attachment", { headers: { Cookie: leaderCookie } })).status, 403, "Leader must not download a member attachment");
    for (const route of ["requests", "requests/nonexistent/respond", "requests/nonexistent/confirm", "requests/nonexistent/attachment", "events/nonexistent/feedback", "events/nonexistent/entry", "events/nonexistent/acknowledge", "tasks/nonexistent/acknowledge"]) {
      const denied = await request(`/api/workflow/${route}`, { method: "POST", headers: { Cookie: leaderCookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(denied.status, 403, `Leader must not mutate ${route}`);
    }
  }

  const separator = sales.indexOf("=");
  const token = sales.slice(separator + 1);
  const segments = token.split(".");
  assert.equal(segments.length, 3, "Expected signed session token");
  segments[2] = (segments[2][0] === "A" ? "B" : "A") + segments[2].slice(1);
  const tampered = sales.slice(0, separator + 1) + segments.join(".");
  assert.equal((await request("/api/dashboard", { headers: { Cookie: tampered } })).status, 401, "Tampered session must be denied");
  await expectRedirect("/sales", "/login", tampered);

  // Use the server-rendered engineer form; the sales dashboard is client-rendered.
  const engineerPage = await request("/engineer", { headers: { Cookie: engineer } });
  const logoutFields = actionFields(await engineerPage.text(), form => form.includes("ログアウト"), "logout");
  const logout = await request("/engineer", {
    method: "POST",
    headers: { Origin: origin, Cookie: engineer, Accept: "text/html" },
    body: logoutFields,
  });
  assert.equal(logout.status, 303);
  assert.equal(location(logout).pathname, "/login");
  assert.ok(logout.headers.getSetCookie().some(value => /^dealhunter_demo_session=;/.test(value) && /Expires=Thu, 01 Jan 1970/i.test(value)), "Logout must expire the browser session cookie");
  await expectRedirect("/sales", "/login");

  console.log(`PASS: ${emptyMode ? "empty case collections, " : ""}real login/logout, safe three-role return paths, nine self-only engineers, two read-only leaders scoped to assigned projects, ${linkedEntryCount} linked entries with source interviews, confirmation metadata/access, ${anotherEngineerEvent ? "cross-engineer schedule confirmation rejected, " : "cross-engineer schedule confirmation not exercised (no other engineer event), "}sales directories, protected pages/API, mutation role/origin checks and cookie tamper rejection.`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : "Authentication verification failed"}`);
  process.exitCode = 1;
}
