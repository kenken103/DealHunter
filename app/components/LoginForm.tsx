"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { DEMO_ENGINEERS, DEMO_LEADERS } from "../demo-accounts";

type Props = {
  action: (formData: FormData) => Promise<void>;
  error?: string;
  nextPath?: string;
};

const demoAccounts = [
  { role: "営業", name: "青木 美咲", email: "sales.aoki@dealhunter.example", password: "demo-sales" },
  { role: "エンジニア", name: "高橋 蓮", email: "engineer.takahashi@dealhunter.example", password: "demo-engineer" },
  { role: "リーダー", name: "佐藤 健一", email: "leader.sato@dealhunter.example", password: "demo-leader" },
] as const;

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="dh-login-submit" disabled={pending}>{pending ? "ログイン中…" : "ログイン"}<span aria-hidden="true">→</span></button>;
}

export default function LoginForm({ action, error, nextPath }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [filledAccount, setFilledAccount] = useState("");
  const [engineerId, setEngineerId] = useState<string>(DEMO_ENGINEERS[0].id);
  const [leaderId, setLeaderId] = useState<string>(DEMO_LEADERS[0].id);
  const emailRef = useRef<HTMLInputElement>(null);

  function fillDemo(account: { role: string; name: string; email: string; password: string }) {
    setEmail(account.email);
    setPassword(account.password);
    setFilledAccount(`${account.role}のデモアカウントを入力しました。`);
    emailRef.current?.focus();
  }

  function selectEngineer(id: string) {
    setEngineerId(id);
    const engineer = DEMO_ENGINEERS.find(item => item.id === id);
    if (engineer) {
      setEmail(engineer.email);
      setPassword("demo-engineer");
      setFilledAccount(`${engineer.name}さんのデモアカウントを入力しました。`);
    }
  }

  function selectLeader(id: string) {
    setLeaderId(id);
    const leader = DEMO_LEADERS.find(item => item.id === id);
    if (leader) fillDemo({ ...leader, role: "リーダー", password: "demo-leader" });
  }

  return <div className="dh-login-shell">
    <header className="dh-login-header"><div className="dh-login-header-inner">
      <div className="dh-login-brand"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></div>
      <span className="dh-login-header-caption">SES面談・入場管理</span>
    </div></header>
    <main className="dh-login-main">
      <section className="dh-login-card" aria-labelledby="dh-login-title">
        <div className="dh-login-heading"><p className="dh-login-eyebrow">DealHunterへようこそ</p><h1 id="dh-login-title">ログイン</h1><p className="dh-login-description">面談から初回入場まで、<br className="dh-login-mobile-break" />次の一歩をここから。</p></div>
        <form action={action} className="dh-login-form">
          {nextPath && <input type="hidden" name="next" value={nextPath} />}
          {error && <p className="dh-login-error" role="alert" id="dh-login-error">{error}</p>}
          <div className="dh-login-field"><label htmlFor="dh-login-email">メールアドレス</label><input ref={emailRef} id="dh-login-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={email} onChange={event => { setEmail(event.target.value); setFilledAccount(""); }} required aria-describedby={error ? "dh-login-error" : undefined} placeholder="name@example.com" /></div>
          <div className="dh-login-field"><label htmlFor="dh-login-password">パスワード</label><div className="dh-login-password"><input id="dh-login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required aria-describedby={error ? "dh-login-error" : undefined} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "パスワードを隠す" : "パスワードを表示"} aria-pressed={showPassword}>{showPassword ? "隠す" : "表示"}</button></div></div>
          <SubmitButton />
        </form>
        <p className="dh-login-routing-note">登録された利用者区分に応じて、<br />営業・エンジニア・リーダーのホームが開きます。</p>
        <div className="dh-login-demo">
          <div className="dh-login-demo-heading"><span>デモで試す</span><small>アカウントを入力</small></div>
          <div className="dh-login-demo-accounts">{demoAccounts.map(account => {
            const engineer = DEMO_ENGINEERS.find(item => item.id === engineerId) ?? DEMO_ENGINEERS[0];
            const leader = DEMO_LEADERS.find(item => item.id === leaderId) ?? DEMO_LEADERS[0];
            const selected = account.role === "エンジニア" ? { ...engineer, role: "エンジニア", password: "demo-engineer" } : account.role === "リーダー" ? { ...leader, role: "リーダー", password: "demo-leader" } : account;
            return <button type="button" className={account.role === "リーダー" ? "dh-login-demo-leader-card" : undefined} key={account.role} onClick={() => fillDemo(selected)} aria-label={`${account.role}のデモアカウントを入力`}><span className={`dh-login-demo-role${account.role === "エンジニア" ? " dh-login-demo-engineer" : ""}`}>{account.role}{account.role === "リーダー" && "・状況確認"}</span><strong>{selected.name}</strong><span aria-hidden="true">↗</span></button>;
          })}</div>
          <label className="dh-login-engineer-picker" htmlFor="demo-engineer">エンジニアを切り替える<select id="demo-engineer" value={engineerId} onChange={event => selectEngineer(event.target.value)}>{DEMO_ENGINEERS.map(engineer => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select></label>
          <label className="dh-login-engineer-picker" htmlFor="demo-leader">リーダーを切り替える<select id="demo-leader" value={leaderId} onChange={event => selectLeader(event.target.value)}>{DEMO_LEADERS.map(leader => <option key={leader.id} value={leader.id}>{leader.name}</option>)}</select></label>
          <p className="dh-login-demo-note">架空のアカウントで業務の流れを試せます。<br />実際の業務アカウントは使用しないでください。</p>
        </div>
        <p className="dh-login-announcement" role="status">{filledAccount}</p>
      </section>
      <p className="dh-login-footer">DealHunter · 面談と、その先へ。</p>
    </main>
  </div>;
}
