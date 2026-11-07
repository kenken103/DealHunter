import { redirect } from "next/navigation";
import { getDemoUser, homeFor } from "./lib/demo-auth";

export default async function Home() {
  const user = await getDemoUser();
  redirect(user ? homeFor(user.role) : "/login");
}
