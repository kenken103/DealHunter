import "server-only";
import { backendRequest } from "./backend";
import { getDemoUser } from "./demo-auth";
import { accountJson, readAccountMutation } from "./json-mutation";

export async function requestDraftApi(request: Request, id?: string) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  if (user.role !== "sales") return accountJson({ error: "営業のみ利用できます。" }, 403);
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return accountJson({ error: "下書きが見つかりません。" }, 404);
  const path = id === undefined ? "request-drafts" : "request-drafts/" + id;
  if (request.method === "GET") return backendRequest(user, path);
  const limit = request.method === "DELETE" ? 1024 : 8 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit) return accountJson({ error: "送信内容が大きすぎます。" }, 413);
  const parsed = await readAccountMutation(request, limit);
  if (parsed.error) return parsed.error;
  return backendRequest(user, path, parsed.body, request.method);
}
