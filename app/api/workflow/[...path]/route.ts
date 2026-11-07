import { NextResponse } from "next/server";
import { getDemoUser } from "../../../lib/demo-auth";
import { backendRequest } from "../../../lib/backend";

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const user = await getDemoUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin) {
    // Next's internal request URL may use localhost while the browser uses 127.0.0.1.
    // Validate the public Host header rather than the internal server URL.
    let validOrigin = false;
    try {
      const source = new URL(origin);
      const host = request.headers.get("host") ?? new URL(request.url).host;
      validOrigin = (source.protocol === "http:" || source.protocol === "https:") && source.host === host;
    } catch { }
    if (!validOrigin) return NextResponse.json({ error: "この操作はログイン中の画面から行ってください。" }, { status: 403 });
  }
  const route = (await params).path.join("/");
  if (!/^(requests|requests\/[A-Za-z0-9_-]+\/(respond|confirm|attachment)|events\/[A-Za-z0-9_-]+\/(feedback|entry|acknowledge)|tasks\/[A-Za-z0-9_-]+\/acknowledge)$/.test(route)) {
    return NextResponse.json({ error: "操作が見つかりません。" }, { status: 404 });
  }
  const studentAction = route.endsWith("/respond") || route.endsWith("/feedback") || (route.startsWith("events/") && route.endsWith("/acknowledge"));
  if (user.role !== (studentAction ? "student" : "sales")) {
    return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "JSON形式で送信してください。" }, { status: 415 });
  }
  let body: unknown;
  try {
    const text = await request.text();
    const limit = route === "requests" || route.endsWith("/attachment") ? 7_100_000 : 1_000_000;
    if (text.length > limit) return NextResponse.json({ error: "送信内容が大きすぎます。" }, { status: 413 });
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
  } catch {
    return NextResponse.json({ error: "入力内容を確認してください。" }, { status: 400 });
  }
  return backendRequest(user, route, body);
}
