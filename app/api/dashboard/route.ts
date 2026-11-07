import { NextResponse } from "next/server";
import { getDemoUser } from "../../lib/demo-auth";
import { backendRequest } from "../../lib/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return backendRequest(user, "dashboard");
}
