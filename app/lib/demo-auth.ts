import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { accountBackend } from "./account-backend";
import { isLocalDemoRequest } from "./local-demo";
import type { UserRole } from "../types";

export type DemoUser = { id: string; name: string; role: UserRole; sessionVersion?: number };
export class LoginRateLimitError extends Error {}

const COOKIE = "dealhunter_demo_session";
const MAX_AGE = 8 * 60 * 60;
const ISSUER = "dealhunter-local";
const AUDIENCE = "dealhunter-demo";

// Backend startup creates .local. Passing the directory itself to the Next
// bundler would also track the running PostgreSQL database inside it.
const sessionKeyFile = path.join(process.cwd(), ".local", "demo-auth.key");

async function createSigningKey() {
  // Publish only a complete key. Another startup can win without overwriting it.
  const temporary = sessionKeyFile + "." + randomUUID() + ".tmp";
  const key = randomBytes(32);
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(key); } finally { await file.close(); }
    try {
      await link(temporary, sessionKeyFile);
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return await readFile(sessionKeyFile);
    }
  } finally {
    await unlink(temporary);
  }
}

async function signingKey() {
  let key: Buffer;
  try {
    key = await readFile(sessionKeyFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = await createSigningKey();
  }
  if (key.length !== 32) throw new Error("Invalid local demo session key");
  return key;
}

function isUser(value: unknown): value is DemoUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && typeof user.name === "string" && ["sales", "student", "leader", "admin"].includes(String(user.role));
}

export async function authenticateDemoUser(email: string, password: string): Promise<DemoUser | null> {
  if (email.trim().toLowerCase().endsWith("@dealhunter.example") && !(await isLocalDemoRequest())) return null;
  const result = await accountBackend<{ user?: unknown }>("auth/login", { email, password });
  if (result.status === 429) throw new LoginRateLimitError();
  if (result.status === 401 || result.status === 400) return null;
  if (result.status !== 200 || !isUser(result.data.user)) throw new Error("Account service unavailable");
  return result.data.user;
}

export const homeFor = (role: DemoUser["role"]) => role === "admin" ? "/admin" : role === "sales" ? "/sales" : role === "leader" ? "/leader" : "/engineer";

export async function createDemoSession(user: DemoUser) {
  const token = await new SignJWT({ version: user.sessionVersion ?? 0 })
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
    return result.status === 200 && isUser(result.data.user) && (payload.version ?? 0) === (result.data.user.sessionVersion ?? 0) ? result.data.user : null;
  } catch {
    return null;
  }
}

export async function deleteDemoSession() {
  (await cookies()).delete(COOKIE);
}
