"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { logout } from "../actions/auth";
import type { DemoUser } from "../lib/demo-auth";
import type { UserRole } from "../types";
import AdminProjects from "./AdminProjects";

type Account = { id: string; name: string; email: string | null; role: UserRole; leaderId: string | null; leaderName: string | null; isDemo: boolean };
type AccountData = { users: Account[]; leaders: { id: string; name: string }[]; currentUser: DemoUser };
type Review = { role: UserRole; leaderId: string | null };
const roleLabels: Record<UserRole, string> = { student: "エンジニア", leader: "リーダー", sales: "営業", admin: "管理者" };
const roleOptions: UserRole[] = ["student", "leader", "sales", "admin"];

export default function AdminDashboard({ user }: { user: DemoUser }) {
  const [tab, setTab] = useState<"accounts" | "projects">("accounts");
  const [projectsOpened, setProjectsOpened] = useState(false);
  const [data, setData] = useState<AccountData | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | UserRole>("all");
  const [role, setRole] = useState<UserRole>("student");
  const [leaderId, setLeaderId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [editError, setEditError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const requestVersion = useRef(0);
  const saving = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const editErrorRef = useRef<HTMLParagraphElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store", signal });
      if (response.status === 401) { window.location.assign("/login?next=%2Fadmin"); return; }
      if (response.status === 403) { window.location.assign("/"); return; }
      const result = await response.json() as AccountData & { error?: string };
      if (!response.ok) throw new Error(result.error || "アカウントを取得できませんでした。");
      if (!Array.isArray(result.users) || !Array.isArray(result.leaders)) throw new Error("アカウント情報を取得できませんでした。");
      if (!active.current || version !== requestVersion.current) return;
      setData(result); setError("");
      setSelectedId(current => result.users.some(account => account.id === current) ? current : result.users[0]?.id || "");
    } catch (reason) {
      if (active.current && version === requestVersion.current && !signal?.aborted) setError(reason instanceof Error ? reason.message : "アカウントを取得できませんでした。もう一度お試しください。");
    } finally { if (active.current && version === requestVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { active.current = false; requestVersion.current++; controller.abort(); };
  }, [refresh]);
  const selected = data?.users.find(account => account.id === selectedId);
  useEffect(() => {
    if (selected) { setRole(selected.role); setLeaderId(selected.leaderId || ""); }
    setReview(null); setEditError(""); setSaved(false);
  }, [selected]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);
  useEffect(() => { if (editError) editErrorRef.current?.focus({ preventScroll: true }); }, [editError]);
  useEffect(() => { if (notice) noticeRef.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { if (review) reviewRef.current?.focus({ preventScroll: true }); }, [review]);

  const search = query.trim().toLocaleLowerCase("ja");
  const accounts = data?.users.filter(account => (filter === "all" || account.role === filter) && (!search || `${account.name} ${account.email || ""} ${account.leaderName || ""}`.toLocaleLowerCase("ja").includes(search))) ?? [];
  const nextLeaderId = role === "student" ? leaderId || null : null;
  const changed = !!selected && (role !== selected.role || nextLeaderId !== (selected.leaderId || null));
  const leaderName = (id: string | null) => data?.leaders.find(leader => leader.id === id)?.name || "所属なし";

  function selectAccount(account: Account) {
    if (saving.current) return;
    setSelectedId(account.id); setNotice("");
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches) { editorRef.current?.scrollIntoView({ block: "start" }); editorRef.current?.focus({ preventScroll: true }); }
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving.current || saved || !changed) return;
    setEditError(""); setNotice("");
    if (role === "student" && leaderId && !data?.leaders.some(leader => leader.id === leaderId && leader.id !== selected.id)) {
      setEditError("現在のリーダーから所属先を選択してください。"); return;
    }
    if (!review) { setReview({ role, leaderId: nextLeaderId }); return; }
    saving.current = true; setPending(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(selected.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(review),
      });
      const result = await response.json() as { error?: string };
      if (response.status === 401 || response.status === 403) { window.location.assign("/"); return; }
      if (!response.ok) throw new Error(result.error || "変更を保存できませんでした。");
      setSaved(true); setReview(null);
      if (selected.id === user.id && review.role !== "admin") { window.location.assign("/"); return; }
      setNotice(`${selected.name}さんのアカウント情報を更新しました。`);
      await refresh();
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "変更を保存できませんでした。通信状態を確認してください。");
    } finally { saving.current = false; setPending(false); }
  }

  return <div className="dh-admin-shell">
    <a className="dh-admin-skip" href={tab === "projects" ? "#dh-projects-title" : "#dh-admin-title"}>本文へ移動</a>
    <header className="dh-admin-header"><Link href="/admin" className="dh-admin-brand" aria-label="DealHunter 管理画面"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></Link><div className="dh-admin-user"><span>管理者</span><strong>{user.name}</strong><form action={logout}><button type="submit">ログアウト</button></form></div></header>
    <main className="dh-admin-main">
      <nav className="dh-admin-tabs" aria-label="管理メニュー"><button type="button" aria-pressed={tab === "accounts"} onClick={() => setTab("accounts")}>アカウント管理</button><button type="button" aria-pressed={tab === "projects"} onClick={() => { setProjectsOpened(true); setTab("projects"); }}>案件管理</button></nav>
      {projectsOpened && <div hidden={tab !== "projects"}><AdminProjects /></div>}
      {tab === "accounts" && <>
      <p className="dh-admin-eyebrow">管理者デスク / 利用者の管理</p>
      <div className="dh-admin-heading"><div><h1 id="dh-admin-title">アカウント管理</h1><p>異動や役割の変更に合わせて、利用者の役割と所属リーダーを編集できます。</p></div><button className="dh-admin-button" type="button" disabled={loading || pending} onClick={() => { setNotice(""); void refresh(); }}>{loading ? "更新中…" : "更新"}</button></div>
      {error && <p className="dh-admin-error" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
      {notice && <p className="dh-admin-notice" ref={noticeRef} tabIndex={-1} role="status">{notice}</p>}
      <div className="dh-admin-summary" aria-label="利用者の件数"><span>全アカウント <strong>{data?.users.length ?? 0}</strong> 名</span>{roleOptions.map(item => <span key={item}>{roleLabels[item]} <strong>{data?.users.filter(account => account.role === item).length ?? 0}</strong> 名</span>)}</div>
      <div className="dh-admin-layout">
        <section className="dh-admin-panel" aria-labelledby="dh-admin-list-title">
          <div className="dh-admin-list-head"><h2 id="dh-admin-list-title">利用者一覧</h2><div className="dh-admin-filters"><div className="dh-admin-field"><label htmlFor="dh-admin-search">氏名・メールアドレスで検索</label><input id="dh-admin-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="氏名・メール・所属リーダー" disabled={pending} /></div><div className="dh-admin-field"><label htmlFor="dh-admin-filter">役割で絞り込み</label><select id="dh-admin-filter" value={filter} onChange={event => setFilter(event.target.value as "all" | UserRole)} disabled={pending}><option value="all">すべての役割</option>{roleOptions.map(item => <option value={item} key={item}>{roleLabels[item]}</option>)}</select></div></div></div>
          <p className="dh-admin-list-count">{accounts.length} / {data?.users.length ?? 0} 名</p>
          {data ? accounts.length ? <ul className="dh-admin-user-list">{accounts.map(account => <li key={account.id}><button className={`dh-admin-account${selectedId === account.id ? " is-selected" : ""}`} type="button" aria-pressed={selectedId === account.id} onClick={() => selectAccount(account)} disabled={pending}><span className="dh-admin-account-main"><strong>{account.name}{account.id === user.id ? "（自分）" : ""}</strong><span>{account.email || "メール未登録"}</span>{account.leaderName && <span>所属：{account.leaderName}</span>}{account.isDemo && <span>デモアカウント</span>}</span><span className={`dh-admin-role-badge is-${account.role}`}>{roleLabels[account.role]}</span></button></li>)}</ul> : <p className="dh-admin-empty">条件に一致するアカウントはありません。</p> : <p className="dh-admin-empty">{loading ? "アカウントを読み込んでいます…" : "画面上部の「更新」からアカウントを取得してください。"}</p>}
        </section>
        <section className="dh-admin-panel" aria-labelledby="dh-admin-editor-title" ref={editorRef} tabIndex={-1} aria-busy={pending}>
          <div className="dh-admin-editor-head"><h2 id="dh-admin-editor-title">{selected?.name || "編集するアカウントを選択"}</h2>{selected && <p>{selected.email || "メール未登録"}</p>}</div>
          {selected ? <form className="dh-admin-editor-body" onSubmit={submit}>
            <span className={`dh-admin-role-badge is-${selected.role}`}>現在：{roleLabels[selected.role]}</span>
            {editError && <p className="dh-admin-error" ref={editErrorRef} tabIndex={-1} role="alert">{editError}</p>}
            {review ? <><div className="dh-admin-review"><h3 ref={reviewRef} tabIndex={-1}>変更内容を確認</h3><dl><div><dt>氏名</dt><dd>{selected.name}</dd></div><div><dt>役割</dt><dd>{roleLabels[selected.role]} → <strong>{roleLabels[review.role]}</strong></dd></div>{(selected.role === "student" || review.role === "student") && <div><dt>所属リーダー</dt><dd>{leaderName(selected.leaderId)} → <strong>{review.role === "student" ? leaderName(review.leaderId) : "所属なし"}</strong></dd></div>}</dl><p className="dh-admin-note">保存後は新しい役割のホームと操作権限が適用されます。これまでの面談・所感・案件の記録は保持されます。</p>{selected.id === user.id && review.role !== "admin" && <p className="dh-admin-note">自分の役割を変更すると、新しい役割のホームへ移動します。</p>}</div><div className="dh-admin-actions"><button className="dh-admin-button" type="button" disabled={pending} onClick={() => { setReview(null); setEditError(""); requestAnimationFrame(() => roleRef.current?.focus()); }}>編集に戻る</button><button className="dh-admin-button is-primary" type="submit" disabled={pending}>{pending ? "保存中…" : "この内容で保存"}</button></div></> : <><fieldset className="dh-admin-edit-fields" disabled={pending || saved || loading}><div className="dh-admin-field"><label htmlFor="dh-admin-role">変更後の役割</label><select id="dh-admin-role" ref={roleRef} value={role} onChange={event => { setRole(event.target.value as UserRole); setEditError(""); }}>{roleOptions.map(item => <option value={item} key={item}>{roleLabels[item]}</option>)}</select></div>{role === "student" && <div className="dh-admin-field"><label htmlFor="dh-admin-leader">所属リーダー</label><select id="dh-admin-leader" value={leaderId} onChange={event => setLeaderId(event.target.value)}><option value="">所属なし</option>{data?.leaders.filter(leader => leader.id !== selected.id).map(leader => <option key={leader.id} value={leader.id}>{leader.name}</option>)}</select><p className="dh-admin-note">リーダーが面談者を選定するときの候補に反映されます。</p></div>}</fieldset><p className="dh-admin-note">役割を変更しても過去の記録は削除されません。リーダーから別の役割へ変更する前に、部下の所属と未完了の選定依頼を確認してください。</p>{saved && <p className="dh-admin-note">保存済みです。表示が更新されない場合は、画面上部の「更新」で最新の状態を確認してください。</p>}<div className="dh-admin-actions"><button className="dh-admin-button is-primary" type="submit" disabled={pending || saved || loading || !changed}>変更内容を確認</button></div></>}
          </form> : <p className="dh-admin-empty">一覧からアカウントを選ぶと、役割と所属を編集できます。</p>}
        </section>
      </div>
      </>}
    </main>
  </div>;
}
