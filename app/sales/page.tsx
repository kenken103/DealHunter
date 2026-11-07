import { redirect } from "next/navigation";
import Dashboard from "../components/Dashboard";
import { getDemoUser, homeFor } from "../lib/demo-auth";
import { homeLink } from "../lib/return-path";

export default async function SalesHome({ searchParams }: { searchParams: Promise<{ event?: string | string[]; request?: string | string[] }> }) {
  const user = await getDemoUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(homeLink("/sales", await searchParams))}`);
  if (user.role !== "sales") redirect(homeFor(user.role));
  return <Dashboard />;
}
