import { accountBackend } from "../../lib/account-backend";
import { getDemoUser } from "../../lib/demo-auth";
import { accountJson } from "../../lib/json-mutation";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales" && user.role !== "admin") return accountJson({ error: "この操作を行う権限がありません。" }, 403);
  try {
    const result = await accountBackend<{ endCompanies: string[] }>("end-companies", undefined, user.id);
    return accountJson(result.data, result.status);
  } catch { return accountJson({ error: "エンド企業の候補に接続できませんでした。" }, 503); }
}
