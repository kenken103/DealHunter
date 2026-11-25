import "server-only";
import { headers } from "next/headers";
import type { DemoAccount } from "../demo-accounts";
import { accountBackend } from "./account-backend";

const passwords = {
  "legacy-sales": "demo-sales",
  "legacy-student": "demo-engineer",
  "legacy-leader": "demo-leader",
  workbook: "DealHunter-Demo1!",
};
type AccountChoice = Omit<DemoAccount, "password"> & { profile: keyof typeof passwords };

export async function isLocalDemoRequest() {
  const request = await headers();
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
  const host = request.get("host") ?? "";
  const forwardedHost = request.get("x-forwarded-host") ?? host;
  const clients = request.get("x-forwarded-for")?.split(",") ?? [];
  return localHost.test(host) && localHost.test(forwardedHost) && !request.has("forwarded")
    && clients.every(ip => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip.trim()));
}

export async function localDemoAccounts(): Promise<DemoAccount[] | null> {
  if (!(await isLocalDemoRequest())) return [];
  const result = await accountBackend<{ accounts: AccountChoice[] }>("auth/demo-accounts").catch(() => null);
  if (result?.status !== 200) return null;
  return result.data.accounts.map(({ profile, ...account }) => ({ ...account, password: passwords[profile] }));
}
