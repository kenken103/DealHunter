import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AdminDashboard from "../components/AdminDashboard";
import { getDemoUser, homeFor } from "../lib/demo-auth";
import "./admin.css";

export const metadata: Metadata = { title: "アカウント管理｜DealHunter" };

export default async function AdminPage() {
  const user = await getDemoUser();
  if (!user) redirect("/login?next=%2Fadmin");
  if (user.role !== "admin") redirect(homeFor(user.role));
  return <AdminDashboard user={user} />;
}
