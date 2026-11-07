import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDemoUser, homeFor } from "../lib/demo-auth";
import { homeLink } from "../lib/return-path";
import EngineerDashboard from "../components/EngineerDashboard";
import "./engineer.css";

export const metadata: Metadata = { title: "エンジニアホーム｜DealHunter" };

export default async function EngineerHome({ searchParams }: { searchParams: Promise<{ event?: string | string[]; request?: string | string[] }> }) {
  const user = await getDemoUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(homeLink("/engineer", await searchParams))}`);
  if (user.role !== "student") redirect(homeFor(user.role));
  return <EngineerDashboard user={user} />;
}
