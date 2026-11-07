import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDemoUser } from "../../../../lib/demo-auth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getDemoUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  if (user.role !== "sales" && user.role !== "student") return NextResponse.json({ error: "この操作を行う権限がありません。" }, { status: 403 });
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return NextResponse.json({ error: "依頼が見つかりません。" }, { status: 404 });
  try {
    const key = (await readFile(path.join(process.cwd(), ".local", "api-key"), "utf8")).trim();
    const response = await fetch(`http://127.0.0.1:8080/api/requests/${encodeURIComponent(id)}/attachment`, {
      headers: { "X-DealHunter-User": user.id, "X-DealHunter-Key": key },
      cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      return NextResponse.json({ error: result.error || "ファイルを取得できませんでした。" }, { status: response.status, headers: { "Cache-Control": "no-store" } });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("File too large");
    return new Response(bytes, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": response.headers.get("Content-Disposition") || 'attachment; filename="skill-sheet"',
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return NextResponse.json({ error: "ファイルを取得できませんでした。Java APIとデータベースを確認してください。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
