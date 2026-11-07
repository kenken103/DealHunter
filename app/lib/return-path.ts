import type { UserRole } from "../types";
type Query = { event?: string | string[]; request?: string | string[]; project?: string | string[] };

export function homeLink(home: "/sales" | "/engineer" | "/leader", query: Query = {}) {
  const params = new URLSearchParams();
  for (const key of home === "/leader" ? ["project"] as const : ["event", "request"] as const) {
    const value = query[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) params.set(key, value);
  }
  return home + (params.size ? `?${params}` : "");
}

export function safeHomeTarget(role: UserRole, next: unknown) {
  const home = role === "sales" ? "/sales" : role === "leader" ? "/leader" : "/engineer";
  if (typeof next !== "string" || next.length > 2000) return home;
  try {
    const url = new URL(next, "http://dealhunter.local");
    if (url.origin !== "http://dealhunter.local" || url.pathname !== home) return home;
    return homeLink(home, { event: url.searchParams.get("event") ?? undefined, request: url.searchParams.get("request") ?? undefined, project: url.searchParams.get("project") ?? undefined });
  } catch { return home; }
}
