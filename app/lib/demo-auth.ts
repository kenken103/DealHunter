import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { DEMO_ENGINEERS, DEMO_LEADERS } from "../demo-accounts";
import type { UserRole } from "../types";

export type DemoUser = { id: string; name: string; role: UserRole };

// Public sample credentials for the local design demo, never production accounts.
const accounts = [
  { id: "sales-aoki", name: "青木 美咲", role: "sales", email: "sales.aoki@dealhunter.example", password: "demo-sales" },
  ...DEMO_ENGINEERS.map(user => ({ ...user, role: "student" as const, password: "demo-engineer" })),
  ...DEMO_LEADERS.map(user => ({ ...user, role: "leader" as const, password: "demo-leader" })),
] as const;

const COOKIE = "dealhunter_demo_session";
const MAX_AGE = 8 * 60 * 60;
const ISSUER = "dealhunter-local";
const AUDIENCE = "dealhunter-demo";

async function signingKey() {
  const directory = path.join(process.cwd(), ".local");
  const filename = path.join(directory, "demo-auth.key");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(filename, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = await readFile(filename);
  if (key.length !== 32) throw new Error("Invalid local demo session key");
  return key;
}

export function authenticateDemoUser(email: string, password: string): DemoUser | null {
  const account = accounts.find(item => item.email === email.trim().toLowerCase());
  if (!account) return null;
  const actual = Buffer.from(password);
  const expected = Buffer.from(account.password);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { id: account.id, name: account.name, role: account.role };
}

export const homeFor = (role: DemoUser["role"]) => role === "sales" ? "/sales" : role === "leader" ? "/leader" : "/engineer";

export async function createDemoSession(user: DemoUser) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(await signingKey());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // This application is a loopback-only HTTP demo, including `npm start`.
    secure: false,
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function getDemoUser(): Promise<DemoUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await signingKey(), {
      algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE,
    });
    // Roles are resolved from the registered account, never trusted from the form or cookie.
    const account = accounts.find(item => item.id === payload.sub);
    return account ? { id: account.id, name: account.name, role: account.role } : null;
  } catch {
    return null;
  }
}

export async function deleteDemoSession() {
  (await cookies()).delete(COOKIE);
}
