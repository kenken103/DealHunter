import { backendRequest } from "../../../lib/backend";
import { getDemoUser } from "../../../lib/demo-auth";
import { accountJson } from "../../../lib/json-mutation";
import { validEngineerId } from "../../../lib/return-path";

export async function GET(_request: Request, { params }: { params: Promise<{ studentId: string }> }) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales" && user.role !== "leader")
    return accountJson({ error: "営業またはリーダーのみ利用できます。" }, 403);
  const { studentId } = await params;
  if (!validEngineerId(studentId)) return accountJson({ error: "対象のエンジニアが見つかりません。" }, 404);
  return backendRequest(user, `engineer-interview-history/${studentId}`);
}
