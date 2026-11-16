import { accountBackend } from "../../../lib/account-backend";
import { createDemoSession, getDemoUser, homeFor, type DemoUser } from "../../../lib/demo-auth";
import { accountJson, readAccountMutation } from "../../../lib/json-mutation";

export async function POST(request: Request) {
  const parsed = await readAccountMutation(request);
  if (parsed.error) return parsed.error;
  if (await getDemoUser()) return accountJson({ error: "新しいアカウントを登録するときは、先にログアウトしてください。" }, 409);
  const { name, email, password, role } = parsed.body;
  if (Object.keys(parsed.body).some(key => !["name", "email", "password", "role"].includes(key)) || typeof name !== "string" || typeof email !== "string" || typeof password !== "string" || !["student", "leader", "sales"].includes(String(role))) {
    return accountJson({ error: "氏名・メールアドレス・パスワード・役割を確認してください。" }, 400);
  }
  try {
    const result = await accountBackend<{ user?: DemoUser; error?: string }>("auth/register", { name, email, password, role });
    if (result.status !== 200 || !result.data.user) return accountJson(result.data, result.status);
    await createDemoSession(result.data.user);
    return accountJson({ user: result.data.user, redirectTo: homeFor(result.data.user.role) });
  } catch { return accountJson({ error: "登録情報を保存できませんでした。システムの起動を確認して、もう一度お試しください。" }, 503); }
}
