import { backendRequest } from "../../lib/backend";
import { getDemoUser } from "../../lib/demo-auth";
import { accountJson } from "../../lib/json-mutation";

export async function GET() {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales" && user.role !== "student") return accountJson({ error: "この質問集を表示できません。" }, 403);
  return backendRequest(user, "question-groups");
}
