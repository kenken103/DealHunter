"use server";

import { redirect } from "next/navigation";
import { authenticateDemoUser, createDemoSession, deleteDemoSession, LoginRateLimitError } from "../lib/demo-auth";
import { safeHomeTarget } from "../lib/return-path";

export async function login(formData: FormData): Promise<void> {
  const email = formData.get("email");
  const password = formData.get("password");
  const next = formData.get("next");
  const retry = "/login?error=invalid" + (typeof next === "string" && next.length <= 2000 ? `&next=${encodeURIComponent(next)}` : "");
  if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 128) {
    redirect(retry);
  }
  let user;
  try { user = await authenticateDemoUser(email, password); }
  catch (error) { redirect(`/login?error=${error instanceof LoginRateLimitError ? "limited" : "unavailable"}` + (typeof next === "string" && next.length <= 2000 ? `&next=${encodeURIComponent(next)}` : "")); }
  if (!user) redirect(retry);
  await createDemoSession(user);
  redirect(safeHomeTarget(user.role, next));
}

export async function logout(): Promise<void> {
  await deleteDemoSession();
  redirect("/login");
}
