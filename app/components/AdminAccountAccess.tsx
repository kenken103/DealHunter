"use client";
import { useState, type FormEvent } from "react";

export function AccountCodeForm({ accountEmail }: { accountEmail?: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const reset = !!accountEmail;
  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError(""); setCode("");
    try {
      const res = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: reset ? "reset" : "invite", email: accountEmail || form.get("email"), role: form.get("role") }) });
      const data = await res.json();
      if (!res.ok || typeof data.code !== "string") throw new Error(data.error || "コードを発行できませんでした。");
      setCode(data.code);
    } catch (err) { setError(err instanceof Error ? err.message : "通信状態を確認してください。"); }
    finally { setPending(false); }
  }
  return <details className="dh-access-tool"><summary>{reset ? "パスワード再設定コードを発行" : "利用者を招待"}</summary>
    <p>本人と会社メールを社内の連絡経路で確認し、発行したコードを本人だけにお渡しください。有効期限は24時間、使用は1回です。再発行すると以前のコードは失効します。</p>
    <form onSubmit={issue} onChange={() => { setCode(""); setError(""); }}>
      <fieldset disabled={pending} className="dh-admin-edit-fields">
        {reset ? <p>{accountEmail}</p> : <>
          <label className="dh-admin-field">招待する会社メール<input type="email" name="email" required maxLength={254} placeholder="name@legarea.jp" /></label>
          <label className="dh-admin-field">承認する役割<select name="role"><option value="student">エンジニア</option><option value="leader">リーダー</option><option value="sales">営業</option></select></label>
        </>}
        <button className="dh-admin-button" type="submit">{pending ? "発行中…" : reset ? "再設定コードを発行" : "招待コードを発行"}</button>
      </fieldset>
      {error && <p role="alert" className="dh-admin-error">{error}</p>}
      {code && <label className="dh-admin-field" role="status">発行したコード<input readOnly value={code} onFocus={e => e.target.select()} /></label>}
    </form></details>;
}

export function AccountAvailability({ id, name, enabled, refresh }: {
  id: string; name: string; enabled: boolean; refresh: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (pending) return;
    setPending(true); setError("");
    try {
      const res = await fetch("/api/admin/users/" + encodeURIComponent(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存できませんでした。");
      setConfirming(false); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "通信状態を確認してください。"); }
    finally { setPending(false); }
  }
  return <div className="dh-access-tool"><strong>利用状態　{enabled ? "利用中" : "利用停止中"}</strong>
    {confirming ? <><p>{name}さんの利用を{enabled ? "停止します。ログイン中のセッションも無効になります。過去の記録は保持します。" : "再開します。再度ログインできるようになります。"}</p>
      <div className="dh-admin-actions"><button className="dh-admin-button" disabled={pending} onClick={() => setConfirming(false)}>戻る</button>
        <button className="dh-admin-button is-primary" disabled={pending} onClick={save}>{enabled ? "利用停止を確定" : "利用再開を確定"}</button></div></>
      : <button className="dh-admin-button" onClick={() => setConfirming(true)}>{enabled ? "利用を停止" : "利用を再開"}</button>}
    {error && <p role="alert" className="dh-admin-error">{error}</p>}</div>;
}
