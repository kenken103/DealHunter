import { backendRequest } from "../../../lib/backend";
import { getDemoUser } from "../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../lib/json-mutation";

type Context = { params: Promise<{ studentId: string }> };

async function handle(context: Context, request?: Request) {
  const user = await getDemoUser();
  if (!user) return accountJson({ error: "ログインが必要です。" }, 401);
  const { studentId } = await context.params;
  if (!/^[A-Za-z0-9_-]+$/.test(studentId)) return accountJson({ error: "面談者IDが無効です。" }, 400);
  const own = user.role === "student" && user.id === studentId;
  if (!own && (request || user.role !== "sales")) return accountJson({ error: "操作する権限がありません。" }, 403);
  const path = "interviewer-availability/" + encodeURIComponent(studentId);
  if (!request) return backendRequest(user, path);
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  return backendRequest(user, path, parsed.body);
}

export function GET(_request: Request, context: Context) { return handle(context); }
export function POST(request: Request, context: Context) { return handle(context, request); }
