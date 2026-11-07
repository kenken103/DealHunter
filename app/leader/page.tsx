import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDemoUser, homeFor } from "../lib/demo-auth";
import { homeLink } from "../lib/return-path";
import LeaderDashboard from "../components/LeaderDashboard";
import "./leader.css";

export const metadata: Metadata = { title: "リーダーホーム｜DealHunter" };

export default async function LeaderHome({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const user = await getDemoUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(homeLink("/leader", await searchParams))}`);
  if (user.role !== "leader") redirect(homeFor(user.role));
  return <LeaderDashboard user={user} />;
}
