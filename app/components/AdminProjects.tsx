"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DashboardData, ImportedCase, InterviewRequest, Project } from "../types";
import { MeetingRecord, meetingDate, meetingStatus } from "./MeetingRecord";
import { ImportedCaseRecord, importedCaseStage } from "./ImportedCaseRecord";
import { AdminEndCompanyField } from "./CompanyField";
import { trimEndCompany } from "../lib/company-name";
import "./case-workflow.css";

type ProjectData = Pick<DashboardData, "projects" | "requests" | "events" | "importedCases">;
type ProjectRow = { key: string; project: Project; studentId: string | null; person: string; request?: InterviewRequest; imported?: ImportedCase };
type Draft = { name: string; participantName: string; participantNameKana: string; upperCompany: string; primeCompany: string; endCompany: string; category: string; remarks: string; notes: string; executorName: string; followers: string };
const fields: { key: keyof Draft; label: string; max: number; multiline?: boolean }[] = [
  { key: "executorName", label: "案件遂行者", max: 100 },
  { key: "followers", label: "案件フォロー者（1行に1名）", max: 2020, multiline: true },
  { key: "name", label: "案件名", max: 200 },
  { key: "participantName", label: "参画者", max: 200 },
  { key: "participantNameKana", label: "参画者（ひらがな）", max: 200 },
  { key: "upperCompany", label: "上位会社", max: 200 },
  { key: "primeCompany", label: "元請け", max: 200 },
  { key: "endCompany", label: "エンド企業", max: 200 },
  { key: "category", label: "種類", max: 100 },
  { key: "remarks", label: "営業・管理者向け備考", max: 2000, multiline: true },
  { key: "notes", label: "案件概要", max: 20000, multiline: true },
];
function makeDraft(project: Project): Draft {
  return { name: project.name, participantName: project.participantName, participantNameKana: project.participantNameKana, upperCompany: project.upperCompany, primeCompany: project.primeCompany || "", endCompany: project.endCompany, category: project.category || "", remarks: project.remarks || "", notes: project.notes, executorName: project.executorName || "", followers: (project.followerNames || []).join("\n") };
}

function projectRows(data: ProjectData, project: Project) {
  const members = new Map<string | null, ProjectRow>();
  function member(id: string | null, name: string): ProjectRow {
    let row = members.get(id);
    if (!row) {
      row = { key: JSON.stringify([project.id, id]), project, studentId: id, person: name };
      members.set(id, row);
    }
    return row;
  }
  for (const request of data.requests) if (request.projectId === project.id) member(request.studentId, request.person).request = request;
  for (const event of data.events) if (event.projectId === project.id) member(event.studentId, event.person);
  for (const record of data.importedCases) if (record.projectId === project.id) member(record.studentId, record.person || "未設定").imported = record;
  if (!members.size) member(null, "選定待ち");
  return [...members.values()];
}

export default function AdminProjects() {
  const [data, setData] = useState<ProjectData | null>(null);
  const [selection, setSelection] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addingEndCompany, setAddingEndCompany] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState(false);
  const [discardKey, setDiscardKey] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const saving = useRef(false);
  const alive = useRef(false);
  const loadVersion = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const message = useRef<HTMLParagraphElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const discardHeading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/projects", { cache: "no-store", signal });
      if (response.status === 401 || response.status === 403) { window.location.assign("/"); return; }
      const result = await response.json() as ProjectData & { error?: string };
      if (!response.ok) throw new Error(result.error || "案件情報を取得できませんでした。");
      if (!Array.isArray(result.projects) || !Array.isArray(result.requests) || !Array.isArray(result.events) || !Array.isArray(result.importedCases)) throw new Error("案件情報の形式を確認できませんでした。");
      if (!alive.current || version !== loadVersion.current) return;
      setData(result); setError("");
    } catch (reason) {
      if (alive.current && version === loadVersion.current && !signal?.aborted) setError(reason instanceof Error ? reason.message : "案件情報を取得できませんでした。");
    } finally { if (alive.current && version === loadVersion.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { alive.current = false; loadVersion.current++; controller.abort(); };
  }, [refresh]);

  const rows = data ? data.projects.flatMap(project => projectRows(data, project)) : [];
  const selected = rows.find(row => row.key === selection) ?? rows[0];
  const selectedProject = selected?.project;
  useEffect(() => { setDraft(selectedProject ? makeDraft(selectedProject) : null); setAddingEndCompany(false); setReview(false); }, [selectedProject]);
  useEffect(() => { if (review) reviewHeading.current?.focus({ preventScroll: true }); }, [review]);
  useEffect(() => { if (discardKey) discardHeading.current?.focus(); }, [discardKey]);
  useEffect(() => { if (error || notice) message.current?.focus({ preventScroll: true }); }, [error, notice]);

  const search = query.trim().toLocaleLowerCase("ja");
  const filtered = rows.filter(row => !search || [row.project.name, row.person, row.project.participantName, row.project.executorName, ...row.project.followerNames || [], row.project.upperCompany, row.project.primeCompany, row.project.endCompany, row.project.category, row.imported?.outcome].join(" ").toLocaleLowerCase("ja").includes(search));
  const history = data?.events.filter(event => event.projectId === selectedProject?.id && event.studentId === selected?.studentId).sort((a, b) => a.stamp - b.stamp || a.time.localeCompare(b.time)) ?? [];
  const editedEndCompany = draft?.endCompany === selectedProject?.endCompany
    ? draft?.endCompany : trimEndCompany(draft?.endCompany ?? "");
  const original = selectedProject && makeDraft(selectedProject);
  const changedFields = draft && original ? fields.filter(({ key }) => (key === "endCompany" ? editedEndCompany : draft[key]) !== original[key]) : [];
  const changed = changedFields.length > 0;
  function openSelection(key: string) {
    const target = rows.find(row => row.key === key);
    if (!target) return;
    setDraft(makeDraft(target.project));
    setAddingEndCompany(false);
    setSelection(key); setError(""); setNotice(""); setReview(false); setDiscardKey(""); setMobileDetail(true);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function select(key: string) {
    if (saving.current) return;
    if (key === selected?.key) {
      setMobileDetail(true);
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    } else if (changed) setDiscardKey(key);
    else openSelection(key);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !selectedProject || saving.current || !changed) return;
    setError(""); setNotice("");
    const changes: Record<string, string | string[]> = {};
    for (const { key } of changedFields) {
      if (key === "followers") {
        const names = draft.followers.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (names.length > 20 || names.some(name => name.length > 100)) { setError("フォロー者は20名以内、氏名は1名につき100文字以内で入力してください。"); return; }
        changes.followerNames = [...new Set(names)];
      } else {
        if (key === "name" && !draft.name.trim()) { setError("案件名を入力してください。"); return; }
        changes[key] = key === "endCompany" ? editedEndCompany ?? "" : draft[key];
      }
    }
    if (!review) { setReview(true); return; }
    saving.current = true; setPending(true);
    try {
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(selectedProject.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
      if (response.status === 401 || response.status === 403) { window.location.assign("/"); return; }
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "変更を保存できませんでした。");
      setNotice("案件情報を保存しました。同じ案件の各面談者の画面にも反映されます。"); setReview(false);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "変更を保存できませんでした。"); }
    finally { saving.current = false; setPending(false); }
  }

  return <section aria-labelledby="dh-projects-title" className={`dh-admin-projects${mobileDetail ? " is-detail" : ""}`}>
    <div className="dh-admin-heading"><div><h1 id="dh-projects-title">案件管理</h1><p>面談者ごとに状況を確認し、案件遂行者・フォロー者や案件情報を後から登録できます。</p></div><button className="dh-admin-button" type="button" disabled={loading || pending || changed} onClick={() => { setNotice(""); void refresh(); }}>{loading ? "更新中…" : "更新"}</button></div>
    {(error || notice) && <p ref={message} tabIndex={-1} className={error ? "dh-admin-error" : "dh-admin-notice"} role={error ? "alert" : "status"}>{error || notice}</p>}
    {discardKey && <div className="dh-admin-review dh-admin-discard" role="alertdialog" aria-labelledby="dh-discard-title" aria-describedby="dh-discard-description"><h3 id="dh-discard-title" ref={discardHeading} tabIndex={-1}>未保存の変更があります</h3><p id="dh-discard-description">入力した変更を破棄して、別の面談者・案件を開きますか？</p><div className="dh-admin-actions"><button className="dh-admin-button" type="button" onClick={() => { setDiscardKey(""); setMobileDetail(true); requestAnimationFrame(() => heading.current?.focus()); }}>編集を続ける</button><button className="dh-admin-button" type="button" onClick={() => openSelection(discardKey)}>変更を破棄して開く</button></div></div>}
    <div className="dh-admin-layout">
      <section className="dh-admin-panel dh-project-list" aria-labelledby="dh-project-list-title"><div className="dh-admin-list-head"><h2 id="dh-project-list-title" ref={listHeading} tabIndex={-1}>案件一覧（面談者別）</h2><div className="dh-admin-field"><label htmlFor="dh-project-search">案件・担当者・会社で検索</label><input id="dh-project-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="案件名・面談者・遂行者など" disabled={pending} /></div></div><p className="dh-admin-list-count">{filtered.length} / {rows.length} 件</p>
        <ul className="dh-admin-user-list">{filtered.map(row => <li key={row.key}><button type="button" className={`dh-admin-account${row.key === selected?.key ? " is-selected" : ""}`} aria-pressed={row.key === selected?.key} disabled={pending} onClick={() => select(row.key)}><span className="dh-admin-account-main"><strong>{row.project.name}</strong><span>面談者：{row.person} ／ 参画者：{row.project.participantName || "未登録"}</span><span>遂行者：{row.project.executorName || "未登録"}</span><span>{row.project.category || "種類未登録"} ／ 担当営業：{row.project.salesName}</span></span><span className="dh-admin-role-badge">{row.imported ? importedCaseStage(row.imported) : row.request ? `${row.request.round || 1}/${row.request.totalRounds || 1} 面談` : row.studentId ? "面談者決定" : "選定待ち"}</span></button></li>)}</ul>
        {!filtered.length && <p className="dh-admin-empty">{loading ? "案件を読み込んでいます…" : data ? "条件に一致する案件はありません。" : "「更新」から案件を取得してください。"}</p>}
      </section>
      <section className="dh-admin-panel dh-project-editor" aria-labelledby="dh-project-editor-title" aria-busy={pending}>
        <div className="dh-admin-editor-head"><button type="button" className="dh-admin-back" onClick={() => { setMobileDetail(false); requestAnimationFrame(() => listHeading.current?.focus({ preventScroll: true })); }}>← 一覧に戻る</button><h2 id="dh-project-editor-title" ref={heading} tabIndex={-1}>{selectedProject?.name || "案件を選択"}</h2>{selectedProject && <p>面談者：{selected?.person} ／ リーダー：{selectedProject.leaderName || "未設定"}</p>}</div>
        {draft && selectedProject ? <form className="dh-admin-editor-body" onSubmit={submit}>
          {review ? <div className="dh-admin-review"><h3 ref={reviewHeading} tabIndex={-1}>変更内容を確認</h3><dl>{changedFields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{(field.key === "endCompany" ? editedEndCompany : draft[field.key]) || "未登録"}</dd></div>)}</dl><p className="dh-admin-note">同じ案件のすべての面談者に共通する担当情報・案件情報を更新します。</p></div> : <fieldset className="dh-admin-edit-fields" disabled={pending || loading}><p className="dh-admin-note">遂行者・フォロー者は任意です。氏名を入力して後から設定できます。</p>{fields.map(field => field.key === "endCompany" ? <AdminEndCompanyField key={field.key} className="dh-admin-field" value={draft.endCompany} onChange={value => setDraft(current => current ? { ...current, endCompany: value } : current)} addingNew={addingEndCompany} onAddingNewChange={setAddingEndCompany} knownCompanies={data?.projects.map(project => project.endCompany) ?? []} /> : <div key={field.key} className="dh-admin-field"><label htmlFor={`dh-project-${field.key}`}>{field.label}{field.key === "name" ? "（必須）" : ""}</label>{field.multiline ? <textarea id={`dh-project-${field.key}`} value={draft[field.key]} rows={field.key === "notes" ? 7 : 3} maxLength={field.max} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} /> : <input id={`dh-project-${field.key}`} value={draft[field.key]} maxLength={field.max} required={field.key === "name"} onChange={event => setDraft({ ...draft, [field.key]: event.target.value })} />}</div>)}</fieldset>}
          <div className="dh-admin-actions">{review && <button className="dh-admin-button" type="button" disabled={pending} onClick={() => setReview(false)}>編集に戻る</button>}<button className="dh-admin-button is-primary" type="submit" disabled={pending || loading || !changed}>{pending ? "保存中…" : review ? "この内容で保存" : "変更内容を確認"}</button></div>
          <details className="dh-admin-history"><summary>この面談者の面談・入場履歴（{history.length + (selected?.imported ? 1 : 0)}件）</summary>
            {selected?.imported && <ImportedCaseRecord record={selected.imported} />}
            {history.length ? <ol>{history.map(event => <li key={event.key}>
              {event.entry ? <><strong>初回入場</strong><span>{meetingDate(event)}</span><span>{event.engineerConfirmedAt ? "参画（入場済み）" : "入場予定"}</span></>
                : <><strong>面談 {event.round || 1}/{event.totalRounds || 1} · {meetingStatus(event)}</strong><MeetingRecord event={event} /></>}
            </li>)}</ol> : !selected?.imported && <p>確定した面談・入場予定はありません。</p>}
          </details>
        </form> : <p className="dh-admin-empty">一覧から案件を選んでください。</p>}
      </section>
    </div>
  </section>;
}
