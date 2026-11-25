import type { UserRole } from "../types";

export const newInterviewRequestPath = "/sales/requests/new";

export function newInterviewRequestLink(draft?: unknown) {
  return typeof draft === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(draft)
    ? newInterviewRequestPath + "?draft=" + draft : newInterviewRequestPath;
}

export function validEngineerId(id: string) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

export function engineerHistoryLink(id: string) {
  return `/engineers/${encodeURIComponent(id)}/interviews`;
}

export function engineerStatusLink(role: "sales" | "leader") {
  return `/${role}?view=engineers`;
}

type Query = { event?: string | string[]; request?: string | string[]; project?: string | string[]; view?: string | string[] };

export function homeLink(home: "/sales" | "/engineer" | "/leader" | "/admin", query: Query = {}) {
  if (home === "/admin") return home;
  if (query.view === "engineers" && (home === "/sales" || home === "/leader")) return engineerStatusLink(home === "/sales" ? "sales" : "leader");
  const params = new URLSearchParams();
  for (const key of home === "/leader" ? ["project"] as const : ["event", "request"] as const) {
    const value = query[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) params.set(key, value);
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
    if (historyId && validEngineerId(historyId) && (role === "sales" || role === "leader")) return url.pathname;
    if (url.pathname !== home) return home;
    return homeLink(home, { event: url.searchParams.get("event") ?? undefined, request: url.searchParams.get("request") ?? undefined, project: url.searchParams.get("project") ?? undefined, view: url.searchParams.get("view") ?? undefined });
  } catch { return home; }
}
