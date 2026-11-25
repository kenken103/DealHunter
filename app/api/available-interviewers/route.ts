import { backendRequest } from "../../lib/backend";
import { getDemoUser } from "../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../lib/json-mutation";

export async function POST(request: Request) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales") return accountJson({ error: "営業のみ検索できます。" }, 403);
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  return backendRequest(user, "available-interviewers", parsed.body);
}
