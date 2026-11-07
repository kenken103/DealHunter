import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { login } from "../actions/auth";
import LoginForm from "../components/LoginForm";
import { getDemoUser } from "../lib/demo-auth";
import { safeHomeTarget } from "../lib/return-path";
import "./login.css";

export const metadata: Metadata = { title: "ログイン｜DealHunter" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const user = await getDemoUser();
  if (user) redirect(safeHomeTarget(user.role, next));
  return <LoginForm action={login} nextPath={typeof next === "string" ? next : undefined} error={error ? "メールアドレスまたはパスワードが正しくありません。" : undefined} />;
}
