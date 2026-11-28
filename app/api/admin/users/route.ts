import { accountBackend } from "../../../lib/account-backend";
import { getDemoUser } from "../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../lib/json-mutation";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "admin") return accountJson({ error: "管理者のみ利用できます。" }, 403);
  try {
    const result = await accountBackend<Record<string, unknown>>("admin/users", undefined, user.id);
    return accountJson(result.status === 200 ? { ...result.data, currentUser: user } : result.data, result.status);
  } catch { return accountJson({ error: "アカウント一覧に接続できませんでした。もう一度お試しください。" }, 503); }
}

export async function POST(request: Request) {
  const user = await getDemoUser();
  if (!user || user.role !== "admin") return accountJson({ error: "管理者のみ利用できます。" }, user ? 403 : 401);
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  try {
    const result = await accountBackend<Record<string, unknown>>("admin/users", parsed.body, user.id);
    return accountJson(result.data, result.status);
  } catch { return accountJson({ error: "コードを発行できませんでした。もう一度お試しください。" }, 503); }
}
