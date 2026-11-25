import { accountBackend } from "../../../lib/account-backend";
import { getDemoUser } from "../../../lib/demo-auth";
import { accountJson } from "../../../lib/json-mutation";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "admin") return accountJson({ error: "管理者のみ利用できます。" }, 403);
  try {
    const result = await accountBackend<Record<string, unknown>>("admin/projects", undefined, user.id);
    return accountJson(result.data, result.status);
  } catch { return accountJson({ error: "案件一覧に接続できませんでした。もう一度お試しください。" }, 503); }
}
