"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

type RegistrationRole = "student" | "leader" | "sales";
const roles: { id: RegistrationRole; label: string; description: string }[] = [
  { id: "student", label: "エンジニア", description: "面談の日程回答・所感提出" },
  { id: "leader", label: "リーダー", description: "面談者の選定・担当案件の確認" },
  { id: "sales", label: "営業", description: "面談依頼・日程調整・結果登録" },
];

export default function RegisterForm() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [role, setRole] = useState<RegistrationRole>("student");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    setError("");
    const normalizedEmail = email.trim().toLowerCase();
    if (!name.trim() || name.trim().length > 100) { setError("氏名は1〜100文字で入力してください。"); return; }
    if (normalizedEmail.length > 254 || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@legarea\.jp$/i.test(normalizedEmail)) {
      setError("メールアドレスは @legarea.jp のアドレスを入力してください。"); return;
    }
    if (password.length < 10 || password.length > 128) { setError("パスワードは10〜128文字で入力してください。"); return; }
    if (password !== confirmation) { setError("確認用パスワードが一致していません。"); return; }
    saving.current = true; setPending(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: normalizedEmail, password, role, code }),
      });
      const result = await response.json() as { redirectTo?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "登録できませんでした。入力内容を確認してください。");
      window.location.assign(result.redirectTo?.startsWith("/") && !result.redirectTo.startsWith("//") ? result.redirectTo : "/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登録できませんでした。通信状態を確認してもう一度お試しください。");
      saving.current = false; setPending(false);
    }
  }

  return <div className="dh-login-shell dh-register-shell">
    <header className="dh-login-header"><div className="dh-login-header-inner"><Link href="/login" className="dh-login-brand" aria-label="DealHunter ログイン"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></Link><span className="dh-login-header-caption">SES面談・入場管理</span></div></header>
    <main className="dh-login-main">
      <section className="dh-login-card dh-register-card" aria-labelledby="dh-register-title">
        <div className="dh-login-heading"><p className="dh-login-eyebrow">アカウントを作成</p><h1 id="dh-register-title">新規アカウント登録</h1><p className="dh-login-description">社内のDealHunter管理者から招待コードを受け取り、承認されたメールアドレス・役割で登録してください。</p></div>
        <form className="dh-login-form dh-register-form" onSubmit={register} aria-busy={pending}>
          {error && <p id="dh-register-error" className="dh-login-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
          <fieldset disabled={pending} className="dh-register-fields">
            <div className="dh-login-field"><label htmlFor="dh-register-code">招待コード</label><input id="dh-register-code" name="code" autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value.trim())} minLength={32} maxLength={32} required /></div>
            <div className="dh-login-field"><label htmlFor="dh-register-name">氏名</label><input id="dh-register-name" name="name" autoComplete="name" maxLength={100} value={name} onChange={event => setName(event.target.value)} required placeholder="山田 太郎" /></div>
            <div className="dh-login-field"><label htmlFor="dh-register-email">メールアドレス</label><input id="dh-register-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={event => setEmail(event.target.value)} required placeholder="name@legarea.jp" aria-describedby="dh-register-email-note" /><p className="dh-register-note" id="dh-register-email-note">@legarea.jp のメールアドレスだけ登録できます。</p></div>
            <div className="dh-login-field"><label htmlFor="dh-register-password">パスワード</label><div className="dh-login-password"><input id="dh-register-password" name="password" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} required aria-describedby="dh-register-password-note" /><button type="button" aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"} aria-pressed={showPassword} onClick={() => setShowPassword(current => !current)}>{showPassword ? "隠す" : "表示"}</button></div><p className="dh-register-note" id="dh-register-password-note">10〜128文字で入力してください。</p></div>
            <div className="dh-login-field"><label htmlFor="dh-register-confirmation">パスワード（確認）</label><input id="dh-register-confirmation" name="passwordConfirmation" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={10} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></div>
            <fieldset className="dh-register-roles"><legend>役割</legend>{roles.map(item => <label className={`dh-register-role${role === item.id ? " is-selected" : ""}`} key={item.id}><input type="radio" name="role" value={item.id} checked={role === item.id} onChange={() => setRole(item.id)} /><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</fieldset>
          </fieldset>
          <button className="dh-login-submit" type="submit" disabled={pending}>{pending ? "登録中…" : "アカウントを登録"}<span aria-hidden="true">→</span></button>
        </form>
        <p className="dh-register-login">登録済みの方は <Link href="/login">ログイン</Link></p>
      </section>
      <p className="dh-login-footer">DealHunter · 面談と、その先へ。</p>
    </main>
  </div>;
}
