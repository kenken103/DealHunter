import { backendRequest } from "../../lib/backend";
import { getDemoUser } from "../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../lib/json-mutation";

export async function POST(request: Request) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales") return accountJson({ error: "営業のみ類似案件を照合できます。" }, 403);
  // Allow the same 20,000-character summary as request creation, including JSON escapes.
  const parsed = await readAccountMutation(request, 128 * 1024);
  if (parsed.error) return parsed.error;
  const { project, summary, upperCompany, endCompany } = parsed.body;
  return backendRequest(user, "similar-projects", { project, summary, upperCompany, endCompany });
}
