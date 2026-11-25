import { backendRequest } from "../../lib/backend";
import { getDemoUser } from "../../lib/demo-auth";
import { accountJson } from "../../lib/json-mutation";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales") return accountJson({ error: "営業のみ利用できます。" }, 403);
  return backendRequest(user, "question-groups");
}
