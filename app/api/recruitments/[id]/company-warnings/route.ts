import { backendRequest } from "../../../../lib/backend";
import { getDemoUser } from "../../../../lib/demo-auth";
import { accountJson } from "../../../../lib/json-mutation";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインしてください。" }, 401);
  if (user.role !== "leader") return accountJson({ error: "リーダーの操作です。" }, 403);
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return accountJson({ error: "依頼が見つかりません。" }, 404);
  return backendRequest(user, "recruitments/" + id + "/company-warnings");
}
