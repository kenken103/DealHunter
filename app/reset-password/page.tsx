import type { Metadata } from "next";
import Link from "next/link";
import PasswordResetForm from "../components/PasswordResetForm";
import "../login/login.css";

export const metadata: Metadata = { title: "パスワード再設定｜DealHunter" };

export default function PasswordResetPage() {
  return <main className="dh-login-shell"><section className="dh-login-card dh-register-card">
    <h1>パスワード再設定</h1>
    <p>社内のDealHunter管理者に、登録した会社メールアドレスを伝えてください。管理者が本人を確認して再設定コードをお渡しします。</p>
    <PasswordResetForm />
    <p className="dh-register-login"><Link href="/login">ログインへ戻る</Link></p>
  </section></main>;
}
