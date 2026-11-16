import { accountBackend } from "../../../../lib/account-backend";
import { getDemoUser, homeFor, type DemoUser } from "../../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../../lib/json-mutation";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "admin") return accountJson({ error: "管理者のみ利用できます。" }, 403);
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return accountJson({ error: "アカウントが見つかりません。" }, 404);
  try {
    const result = await accountBackend<{ message?: string; error?: string; user?: DemoUser }>(`admin/users/${id}`, parsed.body, user.id);
    return accountJson(result.status === 200 && result.data.user?.id === user.id ? { ...result.data, redirectTo: homeFor(result.data.user.role) } : result.data, result.status);
  } catch { return accountJson({ error: "変更を保存できませんでした。もう一度お試しください。" }, 503); }
}
