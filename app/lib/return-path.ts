import type { UserRole } from "../types";

export const newInterviewRequestPath = "/sales/requests/new";

export function newInterviewRequestLink(draft?: unknown) {
  return typeof draft === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(draft)
    ? newInterviewRequestPath + "?draft=" + draft : newInterviewRequestPath;
}

export function validEngineerId(id: string) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

export function engineerHistoryLink(id: string, query = "") {
  return `/engineers/${encodeURIComponent(id)}/interviews` + (query ? "?" + new URLSearchParams({ q: query }) : "");
}

export function engineerStatusLink(role: "sales" | "leader", query = "", studentId = "") {
  const params = new URLSearchParams({ view: "engineers" });
  if (query) params.set("engineerQuery", query);
  return `/${role}?${params}` + (studentId ? "#engineer-" + encodeURIComponent(studentId) : "");
}

type Query = Record<string, string | string[] | undefined>;

export function homeLink(home: "/sales" | "/engineer" | "/leader" | "/admin", query: Query = {}) {
  if (home === "/admin") return home;
  const params = new URLSearchParams();
  const view = typeof query.view === "string" ? query.view : "";
  const views = home === "/sales" ? ["cases", "tasks", "knowledge", "engineers", "companyLookup"] : home === "/leader" ? ["engineers"] : ["schedule", "requests", "feedback", "inProgress"];
  if (views.includes(view)) params.set("view", view);
  const keys = home === "/leader" ? ["project"] : home === "/sales" ? ["project","event","request","interviewer"] : ["event","request","case","feedback","record","origin"];
  for (const key of keys) {
    const value = query[key];
    if (typeof value === "string" && validEngineerId(value)) params.set(key, value);
  }
  if (home === "/engineer") {
    const choices = { kind: ["meet","entry"], scope: ["history"], part: ["prep","change"], from: ["inProgress","feedback","schedule"], detail: ["1"] };
    for (const [key, allowed] of Object.entries(choices)) {
      const value = query[key];
      if (typeof value === "string" && allowed.includes(value)) params.set(key, value);
    }
  }
  if (home === "/sales" || home === "/leader") {
    for (const key of ["engineerQuery","caseQuery","caseStatus","own","historyPerson","stage","questionQuery","questionCompany"]) {
      const value = query[key];
      if (typeof value === "string" && value.length <= 200) params.set(key, value);
    }
  }
  return home + (params.size ? `?${params}` : "");
}

export function safeHomeTarget(role: UserRole, next: unknown) {
  const home = role === "admin" ? "/admin" : role === "sales" ? "/sales" : role === "leader" ? "/leader" : "/engineer";
  if (typeof next !== "string" || next.length > 2000) return home;
  try {
    const url = new URL(next, "http://dealhunter.local");
    if (url.origin !== "http://dealhunter.local") return home;
    if (role === "sales" && url.pathname === newInterviewRequestPath) {
      const drafts = url.searchParams.getAll("draft");
      return newInterviewRequestLink(drafts.length === 1 ? drafts[0] : undefined);
    }
    const historyId = url.pathname.match(/^\/engineers\/([^/]+)\/interviews$/)?.[1];
    if (historyId && validEngineerId(historyId) && (role === "sales" || role === "leader")) return engineerHistoryLink(historyId, (url.searchParams.get("q") || "").slice(0,200));
    if (url.pathname !== home) return home;
    return homeLink(home, Object.fromEntries(url.searchParams));
  } catch { return home; }
}
