import { accountBackend } from "../../../lib/account-backend";
import { accountJson, readAccountMutation } from "../../../lib/json-mutation";

export async function POST(request: Request) {
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  const { email, code, password } = parsed.body;
  if (typeof email !== "string" || typeof code !== "string" || typeof password !== "string") return accountJson({ error: "入力内容を確認してください。" }, 400);
  try {
    const result = await accountBackend<Record<string, unknown>>("auth/reset-password", { email, code, password });
    return accountJson(result.data, result.status);
  } catch { return accountJson({ error: "接続できませんでした。もう一度お試しください。" }, 503); }
}
