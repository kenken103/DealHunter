import "server-only";

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { accountBackend } from "./account-backend";
import type { UserRole } from "../types";

export type DemoUser = { id: string; name: string; role: UserRole };
export class LoginRateLimitError extends Error {}

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

function isUser(value: unknown): value is DemoUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && typeof user.name === "string" && ["sales", "student", "leader", "admin"].includes(String(user.role));
}

export async function authenticateDemoUser(email: string, password: string): Promise<DemoUser | null> {
  const result = await accountBackend<{ user?: unknown }>("auth/login", { email, password });
  if (result.status === 429) throw new LoginRateLimitError();
  if (result.status === 401 || result.status === 400) return null;
  if (result.status !== 200 || !isUser(result.data.user)) throw new Error("Account service unavailable");
  return result.data.user;
}

export const homeFor = (role: DemoUser["role"]) => role === "admin" ? "/admin" : role === "sales" ? "/sales" : role === "leader" ? "/leader" : "/engineer";

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
    // This application currently runs on loopback HTTP, including `npm start`.
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
    if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.sub)) return null;
    // Resolve current permissions from PostgreSQL on every request. A prior
    // cookie cannot retain privileges after an administrator changes the role.
    const result = await accountBackend<{ user?: unknown }>(`auth/users/${encodeURIComponent(payload.sub)}`);
    return result.status === 200 && isUser(result.data.user) ? result.data.user : null;
  } catch {
    return null;
  }
}

export async function deleteDemoSession() {
  (await cookies()).delete(COOKIE);
}
