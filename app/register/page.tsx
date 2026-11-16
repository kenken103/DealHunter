import type { Metadata } from "next";
import { redirect } from "next/navigation";
import RegisterForm from "../components/RegisterForm";
import { getDemoUser, homeFor } from "../lib/demo-auth";
import "../login/login.css";
import "./register.css";

export const metadata: Metadata = { title: "新規アカウント登録｜DealHunter" };

export default async function RegisterPage() {
  const user = await getDemoUser();
  if (user) redirect(homeFor(user.role));
  return <RegisterForm />;
}
