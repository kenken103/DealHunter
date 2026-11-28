"use client";
import { useState, type FormEvent } from "react";

export default function PasswordResetForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("repeat")) { setError("確認用パスワードが一致しません。"); return; }
    setPending(true); setError("");
    try {
      const response = await fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.get("email"), code: String(data.get("code")).trim(), password: data.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "再設定に失敗しました。");
      setDone(true);
    } catch (err) { setError(err instanceof Error ? err.message : "再設定に失敗しました。"); }
    finally { setPending(false); }
  }
  if (done) return <p role="status">パスワードを変更しました。新しいパスワードでログインしてください。</p>;
  return <form onSubmit={submit} className="dh-login-form">
    {error && <p role="alert" className="dh-login-error">{error}</p>}
    <fieldset disabled={pending} className="dh-register-fields">
      <label className="dh-login-field">会社メールアドレス<input type="email" name="email" autoComplete="username" required /></label>
      <label className="dh-login-field">再設定コード<input name="code" autoComplete="off" spellCheck={false} required /></label>
      <label className="dh-login-field">新しいパスワード（10〜128文字）<input type="password" name="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label>
      <label className="dh-login-field">新しいパスワード（確認）<input type="password" name="repeat" autoComplete="new-password" required /></label>
    </fieldset>
    <button className="dh-login-submit" disabled={pending}>{pending ? "保存中…" : "パスワードを変更"}</button>
  </form>;
}
