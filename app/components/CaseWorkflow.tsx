"use client";

import { useScreenParam, setScreenParams } from "./screen-params";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { DashboardData, ImportedCase, InterviewRequest, Project, ScheduleEvent } from "../types";
import { companyNameForDisplay } from "../lib/company-name";
import type { PreviewDialogKey } from "./PreviewDialog";
import { EntryPlan, PlacementExit, entryState } from "./PlacementEditor";
import { CompanyHistorySearch } from "./CompanyInterviewHistory";
import { ImportedCaseRecord, importedCaseStage } from "./ImportedCaseRecord";
import type { CompanyRole } from "../lib/interviewer-companies";
import { companyRestrictionBadge, useCompanyRestrictions } from "./InterviewerCompanyRestrictions";
import FeedbackEditHistory from "./FeedbackEditHistory";
import { inactiveLabel, inactiveMeeting, meetingStatus } from "./MeetingRecord";
import "./case-workflow.css";

export const interviewResultLabels = { pending: "結果待ち", passed: "合格", rejected: "見送り（先方不合格）", advanced: "通過・次回面談へ", offered: "オファー", declined: "辞退（本人側）" };
const dateTime = (event: ScheduleEvent) => `${new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(event.stamp)} ${event.time}`;
export const orderedMeetings = (events: ScheduleEvent[]) => events.filter(event => !event.entry).sort((a, b) => (a.round || 1) - (b.round || 1) || a.stamp - b.stamp || a.time.localeCompare(b.time));

type Metadata = { upperCompany?: string; primeCompany?: string; endCompany?: string; category?: string; executorName?: string; followerNames?: string[]; remarks?: string };
function FactList({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="case-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function CaseMetadata({ item, includeRemarks = false, includeCompanies = false }: { item: Metadata; includeRemarks?: boolean; includeCompanies?: boolean }) {
  return <FactList rows={[...(includeCompanies ? [["上位会社", item.upperCompany || "未登録"] as [string, ReactNode]] : []), ["元請け", item.primeCompany || "未登録"], ...(includeCompanies ? [["エンド企業", item.endCompany || "未入力"] as [string, ReactNode]] : []), ["種類", item.category || "未登録"], ["案件遂行者", item.executorName || "未設定"], ["案件フォロー者", item.followerNames?.length ? item.followerNames.join("、") : "未設定"], ...(includeRemarks && item.remarks ? [["備考", item.remarks] as [string, ReactNode]] : [])]} />;
}
export function InterviewHistory({ data, projectId, studentId, onEvent }: { data: DashboardData; projectId: string; studentId: string; onEvent?: (event: ScheduleEvent) => void }) {
  const meetings = orderedMeetings(data.events.filter(event => event.projectId === projectId && event.studentId === studentId));
  if (!meetings.length) return <p className="case-muted">面談はまだ確定していません。</p>;
  return <ol className="case-history">{meetings.map(meeting => {
    const feedback = data.feedbacks.find(item => item.eventId === meeting.key);
    return <li key={meeting.key}><div className="case-history-heading"><strong>面談 {meeting.round || 1}/{meeting.totalRounds || 1}</strong><span>{meetingStatus(meeting)}</span></div><p>{inactiveMeeting(meeting) ? "変更前：" : ""}{dateTime(meeting)}</p>{onEvent && <button type="button" className="text-link" onClick={() => onEvent(meeting)}>この面談を見る</button>}<details><summary>面談URL・所感・質問</summary>{!inactiveMeeting(meeting) && /^https?:\/\//i.test(meeting.url) && <p><a className="sales-url" href={meeting.url} target="_blank" rel="noopener noreferrer">面談URLを開く</a></p>}{feedback ? <><FactList rows={[["業務内容", feedback.duties], ["作業工程", feedback.process], ["リモート頻度", feedback.remote], ["所感", feedback.impression]]} />{feedback.questions.length > 0 && <div className="case-history-questions"><strong>聞かれた質問</strong><ul>{feedback.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}<FeedbackEditHistory feedback={feedback} /></> : <p className="case-muted">所感は未提出です。</p>}</details></li>;
  })}</ol>;
}

type CaseRow = { key: string; project: Project; person: string; studentId: string; request?: InterviewRequest; events: ScheduleEvent[]; imported?: ImportedCase };
type SearchableProject = Pick<Project, "participantName" | "upperCompany" | "primeCompany" | "endCompany" | "category" | "executorName" | "followerNames">;

function CardCompanies({ upperCompany, primeCompany, endCompany, badge }: Pick<Project, "upperCompany" | "primeCompany" | "endCompany"> & { badge: (role: CompanyRole, name: string) => ReactNode }) {
  const companies = [
    { role: "upper" as const, label: "上位会社", name: upperCompany, empty: "未登録" },
    { role: "prime" as const, label: "元請け", name: primeCompany, empty: "未入力" },
    { role: "end" as const, label: "エンド企業", name: endCompany, empty: "未入力" },
  ];
  return <span className="case-card-companies">
    {companies.map(({ role, label, name, empty }) => {
      const companyName = companyNameForDisplay(name);
      if (role === "prime" && !companyName) return null;
      return <span className="case-company-row" key={label}>
        <span className="case-company-label">{label}</span>
        <span className="case-company-name" title={companyName}>{companyName ?? empty}</span>
        {companyName && badge(role, companyName)}
      </span>;
    })}
  </span>;
}

function stageOf(row: CaseRow) {
  const entry = row.events.find(event => event.entry);
  if (row.imported?.endedOn) return "参画終了";
  if (entry) return entryState(entry);
  if (row.request && row.request.status !== "confirmed") {
    const label = row.request.responseKind === "unavailable" ? "全候補不可・再調整待ち" : row.request.status === "responded" ? "日時確定待ち" : "日程回答待ち";
    return `面談 ${row.request.round || 1}/${row.request.totalRounds || 1} ${label}`;
  }
  const meeting = orderedMeetings(row.events).at(-1);
  if (meeting && inactiveMeeting(meeting)) return inactiveLabel(meeting);
  if (meeting) return `面談 ${meeting.round || 1}/${meeting.totalRounds || 1} ${meetingStatus(meeting)}`;
  return row.imported ? importedCaseStage(row.imported) : row.request ? "日程調整中" : "面談未登録";
}
function stageGroup(row: CaseRow) {
  if (row.imported?.endedOn || row.events.some(e => e.endedOn)) return "closed";
  if (row.imported && !row.request && !row.events.length) {
    return { joined: "active", declined: "closed", rejected: "closed", unknown: "unknown" }[row.imported.status];
  }
  if (!row.request && !row.events.length) return "unknown";
  const stage = stageOf(row);
  return stage.includes("入場済み") ? "active" : /見送り|辞退|中止|取消|参画終了/.test(stage) ? "closed" : "open";
}
export default function CasePortfolio({ data, onWorkflow, onEvent, onChanged }: { data: DashboardData; onWorkflow: (key: PreviewDialogKey) => void; onEvent: (event: ScheduleEvent) => void; onChanged: () => Promise<void> }) {
  const [search, setSearch] = useScreenParam("caseQuery");
  const [status, setStatus] = useScreenParam("caseStatus", "all");
  const [mine, setMine] = useScreenParam("own");
  const myCasesOnly = mine === "1";
  const setMyCasesOnly = (value: boolean) => setMine(value ? "1" : "");
  const [selectedKey, setSelectedKey] = useState("");
  const [detailView, setDetailView] = useState<"preview" | "open" | "closed">("preview");
  const [personId, setPersonId] = useScreenParam("historyPerson");
  const advancedTools = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 651px)");
    const sync = () => { if (advancedTools.current) advancedTools.current.open = media.matches; };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState("");
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const deleteOpener = useRef<HTMLButtonElement>(null);
  const deletionInFlight = useRef(false);
  const caseSearch = useRef<HTMLInputElement>(null);
  const people = new Map([...data.requests, ...data.events].map(record => [record.studentId, record.person]));
  for (const record of data.importedCases ?? []) {
    if (record.studentId && record.person) people.set(record.studentId, record.person);
  }
  for (const student of data.students) people.set(student.id, student.name);
  const currentStudents = new Set(data.students.map(person => person.id));
  const active = currentStudents.has(personId);
  const restrictions = useCompanyRestrictions(active ? personId : "");
  const personLabels = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const name of people.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  for (const [id, name] of people) personLabels.set(id, (nameCounts.get(name) ?? 0) > 1 ? `${name}（${id}）` : name);
  const personName = personLabels.get(personId) ?? "";
  function selectPerson(id: string) {
    setPersonId(id);
    restrictions.retry();
  }
  function badge(role: CompanyRole, company: string) {
    return companyRestrictionBadge(restrictions.current, role, company, personName);
  }
  const selectedCard = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const backToList = useCallback(() => {
    setDetailView("closed"); setScreenParams({project: null, interviewer: null});
    requestAnimationFrame(() => {
      const card = selectedCard.current?.isConnected ? selectedCard.current : listRef.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]");
      card?.scrollIntoView({ block: "center" });
      card?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!deleteTarget) return;
    const dialog = deleteDialog.current;
    dialog?.showModal();
    cancelDelete.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, [deleteTarget]);

  function openDeletion(event: ReactMouseEvent<HTMLButtonElement>, project: Project) {
    deleteOpener.current = event.currentTarget;
    setDeleteError("");
    setDeleteNotice("");
    setDeleteTarget(project);
  }

  function closeDeletion() {
    if (deletionInFlight.current) return;
    setDeleteTarget(null);
    requestAnimationFrame(() => {
      const target = deleteOpener.current?.isConnected ? deleteOpener.current : caseSearch.current;
      target?.focus();
    });
  }

  async function deleteProject() {
    if (!deleteTarget || deletionInFlight.current) return;
    deletionInFlight.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/workflow/projects/${encodeURIComponent(deleteTarget.id)}/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      if (response.status === 401) { window.location.assign("/login"); return; }
      const result = await response.json().catch(() => null) as { error?: string; message?: string; projectId?: string } | null;
      if (!response.ok) {
        if ([403, 404, 409].includes(response.status)) void onChanged();
        setDeleteError(result?.error || "案件を削除できませんでした。最新の案件情報を確認してください。");
        return;
      }
      if (result?.projectId !== deleteTarget.id) throw new Error();
      setDeletedIds(ids => new Set(ids).add(deleteTarget.id));
      setDeleteNotice(result.message || "案件を削除しました。");
      setDeleteTarget(null);
      setSelectedKey("");
      setDetailView("closed");
      selectedCard.current = null;
      requestAnimationFrame(() => caseSearch.current?.focus());
      void onChanged();
    } catch {
      setDeleteError("削除結果を確認できませんでした。最新の案件情報を確認してください。");
      void onChanged();
    } finally {
      deletionInFlight.current = false;
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (detailView !== "open") return;
    function dismissOnOutsideClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || detailRef.current?.contains(target) ||
        target.closest(".case-portfolio-list > button, dialog") || document.getSelection()?.isCollapsed === false) return;
      if (target.closest("a, button, input, select, textarea, label, summary")) { setDetailView("closed"); setScreenParams({project:null, interviewer:null}); }
      else backToList();
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) backToList();
    }
    document.addEventListener("click", dismissOnOutsideClick, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("click", dismissOnOutsideClick, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [detailView, backToList]);

  function returnToFilteredList() {
    setScreenParams({project: null, interviewer: null});
    setDetailView(current => current === "open" ? "preview" : current);
  }
  const rows = new Map<string, CaseRow>();
  const projects = new Map(data.projects.filter(project => !deletedIds.has(project.id)).map(project => [project.id, project]));
  const pending = data.recruitments.filter(item => item.status === "pending" && projects.has(item.projectId));
  for (const project of projects.values()) {
    for (const request of data.requests.filter(item => item.projectId === project.id)) {
      const key = `${project.id}:${request.studentId}`;
      rows.set(key, { key, project, person: request.person, studentId: request.studentId, request, events: data.events.filter(event => event.projectId === project.id && event.studentId === request.studentId) });
    }
    for (const event of data.events.filter(item => item.projectId === project.id)) {
      const key = `${project.id}:${event.studentId}`;
      if (!rows.has(key)) rows.set(key, { key, project, person: event.person, studentId: event.studentId, events: data.events.filter(item => item.projectId === project.id && item.studentId === event.studentId) });
    }
  }
  for (const imported of data.importedCases ?? []) {
    const project = projects.get(imported.projectId);
    if (!project) continue;
    const studentId = imported.studentId || "";
    const key = `${project.id}:${studentId}`;
    const row = rows.get(key) ?? { key, project, studentId, person: imported.person || "未設定", events: [] };
    rows.set(key, { ...row, imported });
  }
  const listedProjects = new Set([...rows.values()].map(row => row.project.id));
  for (const item of pending) listedProjects.add(item.projectId);
  for (const project of projects.values()) {
    if (listedProjects.has(project.id)) continue;
    const key = `${project.id}:`;
    rows.set(key, { key, project, person: "未設定", studentId: "", events: [] });
  }
  const allRows = [...rows.values()];
  const query = search.trim().toLocaleLowerCase();
  function matchesSearch(name: string, person: string, project: SearchableProject) {
    return [name, person, project.participantName, project.upperCompany, project.primeCompany,
      project.endCompany, project.category, project.executorName, ...(project.followerNames || [])]
      .join(" ").toLocaleLowerCase().includes(query);
  }
  const salesId = data.currentUser.id;
  const canDeleteTarget = deleteTarget && projects.get(deleteTarget.id)?.salesId === salesId;
  const filtered = allRows.filter(row =>
    (!myCasesOnly || row.project.salesId === salesId) &&
    (status === "all" || status === stageGroup(row)) &&
    matchesSearch(row.project.name, row.person, row.project)
  );
  const selected = filtered.find(row => row.key === selectedKey) ?? filtered[0];
  const canEdit = selected?.project.salesId === salesId;
  const latest = selected ? orderedMeetings(selected.events).at(-1) : undefined;
  const entry = selected?.events.find(event => event.entry);
  const pendingRecruitments = pending.filter(item =>
    (status === "all" || status === "open") &&
    (!myCasesOnly || projects.get(item.projectId)?.salesId === salesId) &&
    matchesSearch(item.project, item.leaderName, item)
  );
  const hasCases = allRows.length > 0 || pending.length > 0;
  const [linkedProject] = useScreenParam("project");
  const [linkedPerson] = useScreenParam("interviewer");
  const handledProject = useRef("");
  useEffect(() => {
    if (!linkedProject) {
      if (handledProject.current) setDetailView("closed");
      handledProject.current = "";
      return;
    }
    const key = linkedProject + ":" + linkedPerson;
    if (handledProject.current === key) return;
    handledProject.current = key;
    const item = pending.find(recruitment => recruitment.projectId === linkedProject);
    if (item) { onWorkflow({kind: "recruitment", recruitmentId: item.id}); return; }
    const row = allRows.find(item => item.project.id === linkedProject && (!linkedPerson || item.studentId === linkedPerson));
    if (row) { setSelectedKey(row.key); setDetailView("open"); requestAnimationFrame(() => detailRef.current?.scrollIntoView({block: "nearest"})); }
  }, [linkedProject, linkedPerson, data]);


  function changeStatus(nextStatus: string) {
    setStatus(nextStatus);
    returnToFilteredList();
  }

  function showCase(projectId: string, studentId: string) {
    const key = projectId + ":" + studentId;
    const row = rows.get(key);
    if (row && status !== "all" && status !== stageGroup(row)) setStatus("all");
    if (myCasesOnly && projects.get(projectId)?.salesId !== salesId) setMyCasesOnly(false);
    selectedCard.current = null;
    setScreenParams({caseQuery: null, project: projectId, interviewer: studentId}, true); setSelectedKey(key); setDetailView("open");
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    });
  }
  return <section className="case-portfolio" aria-label="面談者ごとの案件管理">
    <details ref={advancedTools} className="case-portfolio-tools case-extra-tools"><summary>取引先と面談者の履歴を検索</summary>
      <div className="case-portfolio-history">
        <div className="case-portfolio-toolbar"><label>履歴を確認する面談者
          <select value={personId} onChange={event => selectPerson(event.target.value)}>
            <option value="">面談者を選択</option>{[...personLabels].sort((a, b) => a[1].localeCompare(b[1], "ja")).map(([id, name]) => <option key={id} value={id}>{name}{currentStudents.has(id) ? "" : "（履歴のみ）"}</option>)}
          </select>
        </label></div>
        <CompanyHistorySearch data={data} onSelect={showCase} person={personId} personName={personName} badge={badge} />
      </div>
    </details>
    <div className="case-portfolio-filters">
      <div className="case-portfolio-toolbar">
        <label>案件・面談者を検索<input ref={caseSearch} type="search" value={search} onChange={e => { setSearch(e.target.value); returnToFilteredList(); }} placeholder="案件名・氏名・会社・種類" /></label>
        <label>状態<select value={status} onChange={e => changeStatus(e.target.value)}>
          <option value="all">すべて</option><option value="open">対応中</option><option value="active">参画（入場済み）</option><option value="closed">終了・見送り・辞退・中止</option><option value="unknown">結果未登録</option>
        </select></label>
      </div>
      <div className="case-portfolio-quick-filters">
        <div className="case-portfolio-checkboxes" role="group" aria-label="案件の絞り込み">
          <label><input type="checkbox" checked={status === "active"} onChange={e => changeStatus(e.target.checked ? "active" : "all")} />入場中のみ</label>
          <label><input type="checkbox" checked={myCasesOnly} onChange={e => { setMyCasesOnly(e.target.checked); returnToFilteredList(); }} />自分の担当案件のみ</label>
        </div>
        <span aria-live="polite">面談者別 {filtered.length}件{pendingRecruitments.length > 0 && ` / 選定待ち ${pendingRecruitments.length}件`}</span>
      </div>
    </div>
    {deleteNotice && <p className="sales-success" role="status">{deleteNotice}</p>}
    {pendingRecruitments.length > 0 && <section className="case-pending-recruitments" aria-label="面談者の選定待ち">
      <h2>面談者の選定待ち {pendingRecruitments.length}件</h2>
      {pendingRecruitments.map(item => <div className="case-pending-card" key={item.id}>
        <button type="button" className="sales-request-row" onClick={() => onWorkflow({ kind: "recruitment", recruitmentId: item.id })}>
          <strong>{item.project}</strong><span>リーダー：{item.leaderName} · 選定状況を確認</span>
          <CardCompanies upperCompany={item.upperCompany} primeCompany={item.primeCompany} endCompany={item.endCompany} badge={badge} />
        </button>
        {projects.get(item.projectId)?.salesId === salesId && <button type="button" className="sales-secondary sales-delete-request" aria-label={`${item.project}の案件を削除`} onClick={event => {
          const project = projects.get(item.projectId);
          if (project) openDeletion(event, project);
        }}>案件を削除</button>}
      </div>)}
    </section>}
    <div className={`case-portfolio-columns${detailView === "open" ? " is-detail" : detailView === "closed" ? " is-list-only" : ""}`}>
      <div ref={listRef} className="case-portfolio-list" aria-label="案件一覧">
        {filtered.map(row => <button type="button" key={row.key} className={selected?.key === row.key ? "is-selected" : ""} aria-pressed={selected?.key === row.key} onClick={e => {
          selectedCard.current = e.currentTarget; handledProject.current = row.key; setScreenParams({project:row.project.id, interviewer:row.studentId}, true); setSelectedKey(row.key); setDetailView("open");
          requestAnimationFrame(() => { detailRef.current?.scrollIntoView({ block: "start" }); detailRef.current?.focus({ preventScroll: true }); });
        }}>
          <span className="case-card-top">
            <span className={`case-stage is-${stageGroup(row)}`}>{stageOf(row)}</span>
            <svg className="icon" aria-hidden="true" focusable="false"><use href="/icons.svg#i-chevright" /></svg>
          </span>
          <strong>{row.project.name}</strong>
          <span>面談者：{personLabels.get(row.studentId) ?? row.person} · 担当営業：{row.project.salesName} · {row.project.category || "種類未登録"}</span>
          <CardCompanies upperCompany={row.project.upperCompany} primeCompany={row.project.primeCompany} endCompany={row.project.endCompany} badge={badge} />
        </button>)}
        {!filtered.length && !pendingRecruitments.length && <div className="empty-state"><strong>{hasCases ? "条件に一致する案件はありません" : "案件はまだ登録されていません"}</strong>
          <p>{hasCases ? "検索や絞り込みの条件を変更してください。" : "面談依頼を作成すると、面談者ごとに表示されます。"}</p></div>}
      </div>
      {detailView !== "closed" && <aside ref={detailRef} className="case-portfolio-detail" id="case-selected-detail" tabIndex={-1} aria-label="選択した案件と面談履歴">
        {selected ? <>
          <button type="button" className="text-link case-mobile-back" onClick={backToList}>← 一覧へ戻る</button>
          <div className="case-detail-heading">
            <p>案件詳細{!selected.imported && <span className="case-reference">{selected.project.id}</span>}</p>
            <h2>{selected.project.name}</h2>
            <span className={`case-stage is-${stageGroup(selected)}`}>{stageOf(selected)}</span>
          </div>
          <FactList rows={[["面談者", personLabels.get(selected.studentId) ?? selected.person], ["参画者", selected.project.participantName || "未登録"], ["参画者(ひらがな)", selected.project.participantNameKana || "未登録"], ["担当営業", selected.project.salesName], ["リーダー", selected.project.leaderName || "未設定"], ["上位会社", companyNameForDisplay(selected.project.upperCompany) ?? "未登録"], ["エンド企業", companyNameForDisplay(selected.project.endCompany) ?? "未入力"]]} />
          <CaseMetadata item={selected.project} includeRemarks />
          <div className="case-workflow-actions">
            {selected.request && <button type="button" className="sales-secondary" onClick={() => onWorkflow({ kind: canEdit && selected.request?.status === "responded" ? "confirm" : "request", requestId: selected.request?.id })}>
              {!canEdit ? "面談依頼を確認" : selected.request.responseKind === "unavailable" ? "再調整する" : selected.request.status === "responded" ? "面談日時を確定" : "面談依頼を確認"}
            </button>}
            {latest && !entry && latest.result === "pending" && <button type="button" className="sales-secondary" onClick={() => onWorkflow({ kind: "notice", eventId: latest.key })}>
              {!canEdit ? "面談の記録を見る" : latest.status === "feedback-submitted" ? "先方評価・準備事項を編集" : latest.scheduleState === "cancelled" ? "中止の記録を確認" : latest.scheduleState === "postponed" ? "延期した面談を再設定" : "日時・参加案内を変更"}
            </button>}
            {canEdit && latest && !inactiveMeeting(latest) && !entry && (latest.result === "pending" || latest.result === "offered") && <button type="button" className="sales-secondary" onClick={() => onWorkflow({ kind: "entry", eventId: latest.key })}>面談結果・入場予定を登録</button>}
            {canEdit && latest && !inactiveMeeting(latest) && !entry && latest.result === "pending" && (latest.round || 1) < 5 && <button type="button" className="sales-secondary" onClick={() => onWorkflow({ kind: "next-round", eventId: latest.key })}>通過・次回面談を依頼</button>}
            {entry && entry.scheduleState === "scheduled" && <button type="button" className="sales-secondary" onClick={() => onEvent(entry)}>初回入場の記録を見る</button>}
          </div>
          {entry && <EntryPlan key={entry.key + entry.noticeRevision} entry={entry} editable={canEdit} onChanged={onChanged} />}
          {(entry?.endedOn || selected.imported?.endedOn) && <p>参画終了日　{entry?.endedOn || selected.imported?.endedOn}　{entry?.exitReason || selected.imported?.exitReason}</p>}
          {canEdit && selected.studentId && (entry?.engineerConfirmedAt || selected.imported?.status === "joined") && <PlacementExit key={selected.key + (entry?.endedOn || selected.imported?.endedOn || "")} projectId={selected.project.id} studentId={selected.studentId} endedOn={entry?.endedOn || selected.imported?.endedOn} reason={entry?.exitReason || selected.imported?.exitReason} onChanged={onChanged} />}
          <section><h3>案件概要</h3><p className="case-body">{selected.project.notes || "未登録"}</p></section>
          {selected.imported && <section><h3>面談・入場の記録</h3><ImportedCaseRecord record={selected.imported} /></section>}
          {(selected.events.length > 0 || selected.request) && <section><h3>この面談者の面談履歴</h3><InterviewHistory data={data} projectId={selected.project.id} studentId={selected.studentId} onEvent={onEvent} /></section>}
          {canEdit && <section className="case-delete-section"><button type="button" className="sales-secondary sales-delete-request" onClick={event => openDeletion(event, selected.project)}>案件を削除</button></section>}
          <button type="button" className="text-link" onClick={backToList}>一覧へ戻る</button>
        </> : <p className="case-muted">案件を選択してください。</p>}
      </aside>}
    </div>
    {deleteTarget && <dialog ref={deleteDialog} className="case-delete-dialog" aria-labelledby="case-delete-title" aria-describedby="case-delete-name case-delete-warning" onCancel={event => { event.preventDefault(); closeDeletion(); }}>
      <h2 id="case-delete-title" className="d-title">この案件を削除しますか？</h2>
      <p id="case-delete-name" className="case-delete-name">{deleteTarget.name}</p>
      <p id="case-delete-warning" className="case-delete-warning">案件に紐づく全員分の面談依頼・面談や入場の予定と履歴・所感・質問・添付ファイルなどが削除されます。削除したデータは元に戻せません。</p>
      {deleteError && <p className="sales-error" role="alert">{deleteError}</p>}
      <div className="case-delete-actions">
        <button type="button" className="sales-secondary" ref={cancelDelete} onClick={closeDeletion} disabled={deleting}>戻る</button>
        <button type="button" className="d-button sales-delete-confirm" onClick={() => void deleteProject()} disabled={deleting || !canDeleteTarget}>{deleting ? "削除中…" : "案件を削除する"}</button>
      </div>
    </dialog>}
  </section>;
}
