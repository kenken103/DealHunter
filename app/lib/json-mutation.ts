import "server-only";

import { NextResponse } from "next/server";

export const accountJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function readAccountMutation(request: Request): Promise<{ body: Record<string, unknown>; error?: never } | { error: NextResponse; body?: never }> {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    const source = new URL(origin ?? "");
    sameOrigin = source.origin === origin && ["http:", "https:"].includes(source.protocol) && source.host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch { }
  if (!sameOrigin) return { error: accountJson({ error: "この操作はログイン画面または管理画面から行ってください。" }, 403) };
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return { error: accountJson({ error: "JSON形式で送信してください。" }, 415) };
  try {
    const text = await request.text();
    if (text.length > 8192) return { error: accountJson({ error: "入力内容が長すぎます。" }, 413) };
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    return { body: body as Record<string, unknown> };
  } catch { return { error: accountJson({ error: "入力内容を確認してください。" }, 400) }; }
}
