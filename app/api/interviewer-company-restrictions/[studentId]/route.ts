import { backendRequest } from "../../../lib/backend";
import { getDemoUser } from "../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../lib/json-mutation";

type Context = { params: Promise<{ studentId: string }> };

async function handle(request: Request, { params }: Context) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales") return accountJson({ error: "営業のみ利用できます。" }, 403);
  const { studentId } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(studentId)) return accountJson({ error: "面談担当者が見つかりません。" }, 404);
  const path = `interviewer-company-restrictions/${studentId}`;
  if (request.method === "GET") return backendRequest(user, path);

  const parsed = await readAccountMutation(request, 1_000_000);
  if (parsed.error) return parsed.error;
  return backendRequest(user, path, parsed.body);
}

export { handle as GET, handle as POST };
