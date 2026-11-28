"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { demoRoles, type DemoAccount } from "../demo-accounts";

type Props = {
  action: (formData: FormData) => Promise<void>;
  accounts: DemoAccount[] | null;
  error?: string;
  nextPath?: string;
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="dh-login-submit" disabled={pending}>{pending ? "ログイン中…" : "ログイン"}<span aria-hidden="true">→</span></button>;
}

export default function LoginForm({ action, accounts, error, nextPath }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [filledAccount, setFilledAccount] = useState("");
  const [selectedIds, setSelectedIds] = useState<Partial<Record<DemoAccount["role"], string>>>({});
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      if (error) setEmail(sessionStorage.getItem("dealhunter.loginEmail") ?? "");
      sessionStorage.removeItem("dealhunter.loginEmail");
    } catch { /* Storage can be unavailable in a private tab. */ }
  }, [error]);
  const groups = demoRoles.flatMap(group => {
    const choices = (accounts ?? []).filter(account => account.role === group.role);
    const selected = choices.find(account => account.id === selectedIds[group.role]) ?? choices[0];
    return selected ? [{ ...group, choices, selected }] : [];
  });

  function fillDemo(account: DemoAccount) {
    setEmail(account.email);
    setPassword(account.password);
    setSelectedIds(previous => ({ ...previous, [account.role]: account.id }));
    setFilledAccount(`${account.name}さんのログイン情報を入力しました。`);
  }

  return <div className="dh-login-shell">
    <header className="dh-login-header"><div className="dh-login-header-inner">
      <div className="dh-login-brand"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></div>
      <span className="dh-login-header-caption">SES面談・入場管理</span>
    </div></header>
    <main className="dh-login-main">
      <section className="dh-login-card" aria-labelledby="dh-login-title">
        <div className="dh-login-heading"><p className="dh-login-eyebrow">DealHunterへようこそ</p><h1 id="dh-login-title">ログイン</h1><p className="dh-login-description">面談から初回入場まで、<br className="dh-login-mobile-break" />次の一歩をここから。</p></div>
        <form onSubmit={() => { try { sessionStorage.setItem("dealhunter.loginEmail", email); } catch {} }} action={action} className="dh-login-form">
          {nextPath && <input type="hidden" name="next" value={nextPath} />}
          {error && <p className="dh-login-error" role="alert" id="dh-login-error">{error}</p>}
          <div className="dh-login-field"><label htmlFor="dh-login-email">メールアドレス</label><input ref={emailRef} id="dh-login-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={email} onChange={event => { setEmail(event.target.value); setFilledAccount(""); }} required aria-describedby={error ? "dh-login-error" : undefined} placeholder="name@example.com" /></div>
          <div className="dh-login-field"><label htmlFor="dh-login-password">パスワード</label><div className="dh-login-password"><input id="dh-login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required aria-describedby={error ? "dh-login-error" : undefined} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"} aria-pressed={showPassword}>{showPassword ? "隠す" : "表示"}</button></div></div>
          <SubmitButton />
        </form>
        <p className="dh-register-login"><Link href="/reset-password">パスワードを忘れた方</Link></p>
        <p className="dh-login-register-link">初めて利用する方は <Link href="/register">新規アカウント登録</Link></p>
        <p className="dh-login-routing-note">登録された利用者区分に応じて、<br />営業・エンジニア・リーダーのホームが開きます。</p>
        <p className="dh-login-admin-note">管理者も、この画面からログインできます。</p>
        {groups.length > 0 && <div className="dh-login-demo">
          <div className="dh-login-demo-heading"><span>デモで試す</span><small>アカウントを入力</small></div>
          <div className="dh-login-demo-accounts">{groups.map(({role, label, selected}) =>
            <button type="button" key={role} className={role === "leader" ? "dh-login-demo-leader-card" : undefined}
              onClick={() => { fillDemo(selected); emailRef.current?.focus(); }} aria-label={`${label}のデモアカウントを入力`}>
              <span className={`dh-login-demo-role${role === "student" ? " dh-login-demo-engineer" : ""}`}>{label}{role === "leader" && "・状況確認"}</span>
              <strong>{selected.name}</strong><span aria-hidden="true">↗</span>
            </button>
          )}</div>
          {groups.filter(group => group.choices.length > 1).map(({role, label, pickerId, choices, selected}) =>
            <label key={role} className="dh-login-engineer-picker" htmlFor={pickerId}>{label}を切り替える
              <select id={pickerId} value={selected.id} onChange={event => {
                const account = choices.find(item => item.id === event.target.value);
                if (account) fillDemo(account);
              }}>{choices.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>
            </label>
          )}
          <p className="dh-login-demo-note">利用する人を選んで「ログイン」を押してください。</p>
        </div>}
        {accounts === null && <p className="dh-login-demo-note">アカウントの候補を取得できませんでした。起動後にページを再読み込みしてください。</p>}
        <p className="dh-login-announcement" role="status">{filledAccount}</p>
      </section>
      <p className="dh-login-footer">DealHunter · 面談と、その先へ。</p>
    </main>
  </div>;
}
