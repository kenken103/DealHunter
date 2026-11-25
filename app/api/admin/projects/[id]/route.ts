import { accountBackend } from "../../../../lib/account-backend";
import { getDemoUser } from "../../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../../lib/json-mutation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "admin") return accountJson({ error: "管理者のみ利用できます。" }, 403);
  const parsed = await readAccountMutation(request, 100_000);
  if (parsed.error) return parsed.error;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return accountJson({ error: "案件が見つかりません。" }, 404);
  try {
    const result = await accountBackend<Record<string, unknown>>(`admin/projects/${id}`, parsed.body, user.id);
    return accountJson(result.data, result.status);
  } catch { return accountJson({ error: "変更を保存できませんでした。もう一度お試しください。" }, 503); }
}
