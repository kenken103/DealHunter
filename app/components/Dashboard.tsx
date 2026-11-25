"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DashboardData, ScheduleEvent, Task } from "../types";
import PreviewDialog, { type PreviewDialogKey } from "./PreviewDialog";
import { logout } from "../actions/auth";
import { entryForInterview, sourceInterview } from "../lib/interview-history";
import CasePortfolio, { CaseMetadata, InterviewHistory, interviewResultLabels } from "./CaseWorkflow";
import EngineerStatusList from "./EngineerStatusList";
import InterviewerCompanyLookup from "./InterviewerCompanyLookup";
import QuestionLibrary from "./QuestionLibrary";
import { salesRequestState } from "./SalesSchedule";
import { inactiveMeeting, meetingStatus } from "./MeetingRecord";
import { companyNameForDisplay } from "../lib/company-name";
import { japanDayStamp } from "../lib/business-date";
import { newInterviewRequestPath } from "../lib/return-path";
import { useEngineerStatusTab } from "./useEngineerStatusTab";

type View = "schedule" | "tasks" | "knowledge" | "cases" | "engineers" | "companyLookup";
type Filter = "all" | "meet" | "entry";
const DAY = 86400000;
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");
const dateText = (stamp: number) => {
  const d = new Date(stamp);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${DAYS[d.getUTCDay()]}）`;
};
const shortDate = (stamp: number) => {
  const d = new Date(stamp);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};
const monthOf = (stamp: number) => {
  const d = new Date(stamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

function Icon({ name }: { name: string }) {
  return <svg className="icon" aria-hidden="true" focusable="false"><use href={`/icons.svg#i-${name}`} /></svg>;
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="fact-list">{rows.map(([label, value]) => <div className="fact" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function MeetingUrl({ url }: { url: string }) {
  if (!url) return <>未登録</>;
  return <details className="url-preview"><summary>登録リンクを確認</summary><span>{/^https?:\/\//i.test(url) ? <a className="sales-url" href={url} target="_blank" rel="noopener noreferrer">{url}</a> : url}</span>{url.includes("meet.example") && <small>デモ用URL</small>}</details>;
}

type CalendarItem = ScheduleEvent & { mainKey?: string };
function salesCalendar(events: ScheduleEvent[]): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const event of events) {
    if (!event.entry && inactiveMeeting(event)) continue;
    items.push(event);
    if (!event.entry && event.prepStart) {
      const stamp = Date.parse(event.prepStart.slice(0, 10) + "T00:00:00Z");
      items.push({ ...event, mainKey: event.key, key: `prep:${event.key}`, stamp, date: new Date(stamp).getUTCDate(),
        time: event.prepStart.slice(11, 16), end: "", url: event.prepUrl, route: "事前打合せ" });
    }
  }
  return items.sort((a, b) => a.stamp - b.stamp || a.time.localeCompare(b.time));
}

function taskAction(task: Task, requests: DashboardData["requests"], editable: boolean): { target: PreviewDialogKey; label: string } {
  if (task.action === "notice") return { target: { kind: "notice", eventId: task.eventId ?? undefined }, label: editable ? "面談日時・案内を更新" : "面談日時・案内を見る" };
  if (task.action === "assign") return { target: { kind: "recruitment", recruitmentId: task.recruitmentId ?? undefined }, label: "選定状況を見る" };
  if (task.action === "schedule") {
    const req = requests.find(r => r.id === task.requestId);
    const canConfirm = editable && req?.status === "responded";
    return { target: { kind: canConfirm ? "confirm" : "request", requestId: task.requestId ?? undefined },
      label: !canConfirm ? "依頼の状況を見る" : req.responseKind === "unavailable" ? "別の候補を再依頼" : "候補を確認・日時を確定" };
  }
  return { target: { kind: task.action === "entry" ? "entry" : "feedback", eventId: task.eventId ?? undefined },
    label: task.action === "entry" ? (editable ? "面談結果・初回入場を登録" : "面談の記録を見る") : "提出状況を見る" };
}

function TaskReadBadge({ task }: { task: Task }) {
  return <span className={`sales-task-read-badge${task.unread ? " is-unread" : ""}`} title={task.unread ? "内容が未確認です。" : "内容を確認済みです。対応完了ではありません。"}><span aria-hidden="true">{task.unread ? "●" : "✓"}</span>{task.unread ? "未確認" : "確認済み"}</span>;
}

function TaskCounts({ pending, unread }: { pending: number; unread: number }) {
  return <span className="sales-task-counts"><span>対応待ち {pending}件</span><span className="sales-task-count-separator">／</span><span>未確認 {unread}件</span></span>;
}

function CaseArt() {
  return <svg className="case-art" aria-hidden="true" viewBox="0 0 140 85" fill="none">
    <g stroke="#3661AA" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.15">
      <path d="m15 65 53 14 58-18M20 69l6-1.7m49 11.7 42-12.4" opacity=".3" />
      <path d="m26 53 45 12.2 47-14.6L73 38.3z" fill="#E1EAFC" />
      <path d="m26 50.2 45 12.3 47-14.6L73 35.6z" fill="#F5F8FF" />
      <path d="m42 43 6-33.3L86.8 16l8.6 11.4L90 59.8z" fill="#DFE9FA" />
      <path d="m46.1 40.8 6-33.3 38.8 6.4 8.5 11.4L94 57.8z" fill="#F6F9FF" />
      <path d="m90.9 13.9-1.7 9.5 10.2 1.9z" fill="#FFDA36" />
      <path d="m58.7 17.5 17.6 3.1m-18.4.8 9.8 1.7m-11.5 3.9 33.8 6.1-1.6 10.3-34-7.1zm-.8 4.4 33.9 6.6m-11-7.1-1.6 10.2m1 4.6 8.2 1.7" opacity=".65" />
    </g>
  </svg>;
}

function FileHead({ reference, title, status, art = false }: { reference: string; title: string; status?: string; art?: boolean }) {
  return <div className={`file-head${art ? " with-art" : ""}`}>
    {art && <CaseArt />}
    <div className="file-ref"><Icon name="folder" /><span>{reference}</span></div>
    <h2 className="file-name">{art ? <><span className="phrase">法人向け請求管理</span><wbr /><span className="phrase">システム開発</span></> : title}</h2>
    {status && <span className="file-status">{status}</span>}
  </div>;
}

export default function Dashboard() {
  const [today, setToday] = useState(() => japanDayStamp());
  const [data, setData] = useState<DashboardData | null>(null);
  const projectsById = useMemo(() => new Map(data?.projects.map(project => [project.id, project])), [data?.projects]);
  const OWNER = data?.currentUser.name || "読み込み中…";
  const [error, setError] = useState("");
  const [acknowledgeError, setAcknowledgeError] = useState("");
  const [dashboardView, setDashboardView] = useState<Exclude<View, "engineers">>("schedule");
  const [engineerStatusOpen, setEngineerStatusOpen] = useEngineerStatusTab();
  const view = engineerStatusOpen ? "engineers" : dashboardView;
  const [filter, setFilter] = useState<Filter>("all");
  const [start, setStart] = useState(() => japanDayStamp());
  const [month, setMonth] = useState(() => monthOf(japanDayStamp()));
  const [selected, setSelected] = useState("DH-1027");
  const [selectedTask, setSelectedTask] = useState("");
  const [dialog, setDialog] = useState<PreviewDialogKey | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const agendaRef = useRef<HTMLDivElement>(null);
  const readInitialLink = useRef(false);
  const refreshSequence = useRef(0);
  const active = useRef(true);
  const acknowledging = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!active.current) return;
    const sequence = ++refreshSequence.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal: controller.signal });
      if (!active.current || sequence !== refreshSequence.current) return;
      if (response.status === 401) { window.location.assign("/login"); return; }
      if (response.status === 403) { window.location.assign("/"); return; }
      if (!response.ok) throw new Error("予定を取得できませんでした。Java APIとPostgreSQLの起動を確認してください。");
      const updated = await response.json() as DashboardData;
      if (!active.current || sequence !== refreshSequence.current) return;
      if (updated.currentUser.role !== "sales") { window.location.assign(updated.currentUser.role === "leader" ? "/leader" : "/engineer"); return; }
      setData(updated); setToday(japanDayStamp()); setError("");
    } catch (reason) {
      if (!active.current || sequence !== refreshSequence.current) return;
      setError(controller.signal.aborted ? "予定の取得に時間がかかっています。もう一度読み込んでください。"
        : reason instanceof Error ? reason.message : "予定を取得できませんでした。");
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisible);
    const updates = typeof BroadcastChannel === "function" ? new BroadcastChannel(newInterviewRequestPath) : null;
    if (updates) updates.onmessage = event => { if (event.data === "created") void refresh(); };
    const dayTimer = window.setInterval(() => setToday(japanDayStamp()), 60_000);
    return () => { active.current = false; refreshSequence.current++; updates?.close(); window.clearInterval(dayTimer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const acknowledgeTask = useCallback(async (target: Task, snapshot: DashboardData) => {
    if (!snapshot.projects.some(project => project.id === target.projectId && project.salesId === snapshot.currentUser.id)) return;
    if (!target.unread || !active.current) return;
    const key = `${target.key}:${target.revision}`;
    if (acknowledging.current.has(key)) return;
    acknowledging.current.add(key);
    setAcknowledgeError("");
    try {
      const response = await fetch(`/api/workflow/tasks/${encodeURIComponent(target.key)}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: target.revision }) });
      const result = await response.json() as { error?: string; acknowledgedAt?: string };
      if (!active.current) return;
      if (response.status === 401) { window.location.assign("/login"); return; }
      if (!response.ok) throw new Error(result.error || "確認状態を保存できませんでした。もう一度対象の項目を開いてください。");
      refreshSequence.current++;
      setData(current => current ? { ...current, tasks: current.tasks.map(item => item.key === target.key && item.revision === target.revision ? { ...item, unread: false, acknowledgedAt: result.acknowledgedAt ?? new Date().toISOString() } : item) } : current);
    } catch (reason) {
      if (active.current) setAcknowledgeError(reason instanceof Error ? reason.message : "確認状態を保存できませんでした。もう一度対象の項目を開いてください。");
    } finally { acknowledging.current.delete(key); }
  }, []);
  useEffect(() => {
    if (!data || readInitialLink.current) return;
    readInitialLink.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "engineers") return;
    const requested = data.requests.find(item => item.id === params.get("request"));
    const scheduled = data.events.find(item => item.key === params.get("event"));
    if (requested) {
      const linkedTask = data.tasks.find(item => item.requestId === requested.id && item.action === "schedule");
      setDashboardView("tasks"); setSelectedTask(linkedTask?.key ?? "");
      if (linkedTask) void acknowledgeTask(linkedTask, data);
      setDialog({ kind: requested.status === "responded" ? "confirm" : "request", requestId: requested.id });
    } else if (scheduled) {
      if (!scheduled.entry && inactiveMeeting(scheduled)) {
        setDialog({ kind: "notice", eventId: scheduled.key });
      } else { setStart(scheduled.stamp); setMonth(monthOf(scheduled.stamp)); setSelected(scheduled.key); focusDetail(); }
      const linkedTask = data.tasks.find(item => item.eventId === scheduled.key && item.action === "entry") ?? data.tasks.find(item => item.eventId === scheduled.key);
      if (linkedTask) void acknowledgeTask(linkedTask, data);
    }
  }, [data, acknowledgeTask]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const allEvents = data?.events ?? [];
  const events = salesCalendar(allEvents);
  const questions = data?.questions ?? [];
  const tasks = data?.tasks ?? [];
  const unreadTasks = tasks.filter(item => item.unread).length;
  const requests = data?.requests ?? [];
  const pendingRecruitments = data?.recruitments?.filter(item => item.status === "pending") ?? [];
  const upcoming = events.filter(e => Date.parse(`${new Date(e.stamp).toISOString().slice(0, 10)}T${e.time}:00+09:00`) >= Date.now());
  const nextMeet = upcoming.find(e => e.type === "meet" && e.result === "pending" && e.status !== "entry-registered");
  const nextEntry = upcoming.find(e => e.type === "entry" && !e.engineerConfirmedAt);
  const list = events.filter(e => e.stamp >= start && e.stamp < start + 7 * DAY && (filter === "all" || e.type === filter));
  const event = list.find(e => e.key === selected) ?? list[0];
  const task = tasks.find(t => t.key === selectedTask);
  const taskProject = task && projectsById.get(task.projectId);
  const canEditTask = !!taskProject && taskProject.salesId === data?.currentUser.id;
  const taskLink = task ? taskAction(task, requests, canEditTask) : null;
  const taskEvent = allEvents.find(item => item.key === task?.eventId);
  const title = { schedule: "面談・入場予定", tasks: "対応待ち", knowledge: "質問集", cases: "案件一覧", engineers: "エンジニア状況", companyLookup: "OK・NG検索" }[view];
  const description = {
    schedule: `${new Date(today).getUTCFullYear()}年${dateText(today)}`,
    cases: "面談者ごとの進捗・担当者・面談履歴を確認できます。",
    engineers: "全エンジニアの参画案件を確認できます。氏名から面談履歴を開けます。",
    companyLookup: "取引先とエンジニアの組み合わせを確認できます。",
    tasks: "担当案件と、次に対応する人を確認できます。",
    knowledge: "同じ会社で概要が似ている案件の質問を、面談ごとに確認できます。",
  }[view];

  function selectTask(target: Task) {
    setSelectedTask(target.key); focusDetail();
    if (data) void acknowledgeTask(target, data);
  }

  function openWorkflow(target: PreviewDialogKey) {
    const action = target.kind === "notice" ? "notice" : target.kind === "confirm" ? "schedule" : target.kind === "entry" ? "entry" : target.kind === "feedback" ? "feedback" : target.kind === "recruitment" ? "assign" : undefined;
    const matching = action ? tasks.find(item => item.action === action && (target.eventId ? item.eventId === target.eventId : target.requestId ? item.requestId === target.requestId : target.recruitmentId ? item.recruitmentId === target.recruitmentId : false)) : undefined;
    if (matching && data) void acknowledgeTask(matching, data);
    setDialog(target);
  }

  function focusDetail() {
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 900px)").matches) {
        inspectorRef.current?.scrollIntoView({ block: "start" });
        inspectorRef.current?.focus({ preventScroll: true });
      }
    });
  }

  function backToList() {
    agendaRef.current?.scrollIntoView({ block: "start" });
    agendaRef.current?.querySelector<HTMLButtonElement>(".selected")?.focus({ preventScroll: true });
  }

  function selectView(next: View) {
    if (next !== "engineers") setDashboardView(next);
    setEngineerStatusOpen(next === "engineers");
  }

  function changeWindow(stamp: number) {
    setStart(stamp);
    setMonth(monthOf(stamp));
    selectView("schedule");
    const next = events.filter(e => e.stamp >= stamp && e.stamp < stamp + 7 * DAY && (filter === "all" || e.type === filter));
    if (!next.some(e => e.key === selected)) setSelected(next[0]?.key ?? "");
  }

  function changeFilter(value: Filter) {
    setFilter(value);
    const next = events.filter(e => e.stamp >= start && e.stamp < start + 7 * DAY && (value === "all" || e.type === value));
    if (!next.some(e => e.key === selected)) setSelected(next[0]?.key ?? "");
  }

  function resetToday() {
    changeWindow(today);
    setSelected(events.find(e => e.stamp >= today && e.stamp < today + 7 * DAY)?.key ?? "");
    setFilter("all");
  }

  function showEvent(e: ScheduleEvent) {
    if (!e.entry && inactiveMeeting(e)) {
      openWorkflow({ kind: "notice", eventId: e.key });
      return;
    }
    changeWindow(e.stamp);
    setFilter("all");
    setSelected(e.key);
    focusDetail();
  }

  function jump(type: "meet" | "entry") {
    const next = type === "meet" ? nextMeet : nextEntry;
    if (next) {
      showEvent(next);
    }
  }

  const first = new Date(month);
  const firstVisible = month - ((first.getUTCDay() + 6) % 7) * DAY;
  const monthLength = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const calendarLength = Math.ceil((((first.getUTCDay() + 6) % 7) + monthLength) / 7) * 7;
  const back = <button type="button" className="mobile-back" onClick={backToList}><Icon name="left" />一覧へ戻る</button>;

  function eventDetails() {
    if (!event) return <><FileHead reference="案件詳細" title="予定を選択" /><div className="empty-state"><p>予定を選ぶと、ここに案件の詳細が表示されます。</p></div></>;
    const eventProject = projectsById.get(event.projectId);
    const canEdit = !!eventProject && eventProject.salesId === data?.currentUser.id;
    const mainKey = event.mainKey ?? event.key;
    const mainEvent = allEvents.find(item => item.key === mainKey) ?? event;
    const showNotice = () => openWorkflow({ kind: "notice", eventId: mainKey });
    if (event.mainKey) return <>
      <FileHead reference="事前打合せ" title={event.project} status={`面談 ${event.round || 1}/${event.totalRounds || 1}`} />
      <section className="file-section"><h3>事前打合せの予定</h3><Facts rows={[
        ["開始日時", `${dateText(event.stamp)} ${event.time}`], ["面談者", event.person],
        ["事前打合せURL", event.url ? <MeetingUrl url={event.url} /> : "URL待ち"],
        ["本面談", `${dateText(mainEvent.stamp)} ${mainEvent.time}`],
        ["担当営業", eventProject?.salesName], ["本人の最新案内", event.noticeReadAt ? "確認済み" : "未確認"],
        ...(event.emergencyContact ? [["緊急連絡先", event.emergencyContact] as [string, ReactNode]] : []),
        ...(event.instructions ? [["案内・準備事項", event.instructions] as [string, ReactNode]] : []),
      ]} /><div className="sales-workflow-actions"><button type="button" className="detail-action" onClick={showNotice}>{canEdit ? "日時・案内を管理" : "面談日時・案内を見る"}</button>
        <button type="button" className="detail-action" onClick={() => showEvent(mainEvent)}>本面談の予定を見る</button></div></section>{back}
    </>;
    const associated = questions.filter(q => q.project === event.projectId);
    const source = sourceInterview(event, allEvents);
    const submittedFeedback = data?.feedbacks.find(item => item.eventId === source?.key);
    const entryEvent = entryForInterview(event, allEvents);
    return <>
      <FileHead reference={`案件詳細　/　${event.projectId}`} title={event.project} status={`${event.route}　${event.entry ? event.engineerConfirmedAt ? "参画（入場済み）" : "初回入場予定" : meetingStatus(event)}`} art={event.projectId === "DH-1027"} />
      <section className="file-section">
        <h3>{event.entry ? "初回入場の予定" : "面談の予定"}</h3>
        <Facts rows={[
          ["上位会社", companyNameForDisplay(event.upperCompany) ?? "未登録"],
          ["エンド企業", companyNameForDisplay(event.endCompany) ?? "未入力"],
          [event.entry ? "集合時刻" : "開始日時", <>{dateText(event.stamp)}<br /><span className="fact-time">{event.time}{event.entry ? " 集合" : ""}</span></>],
          ["面談者", event.person],
          ["参画者", event.participantName || "未登録"],
          ["参画者(ひらがな)", event.participantNameKana || "未登録"],
          ["リーダー", event.leaderName || "未設定"],
          [event.entry ? "集合場所" : "実施形式", event.format],
          ["担当営業", eventProject?.salesName],
          ...(!event.entry ? [
            ["本面談URL", event.url ? <MeetingUrl url={event.url} /> : "URL登録待ち"],
            ["本人の最新案内", event.noticeReadAt ? "確認済み" : "未確認"],
            ...(event.prepStart ? [["事前打合せ", <button type="button" className="text-link" onClick={() => {
              const prep = events.find(item => item.mainKey === event.key);
              if (prep) showEvent(prep);
            }}>{event.prepStart.replace("T", " ").slice(0, 16)} の予定を見る</button>]] : []),
            ...(event.meetingId ? [["会議ID", event.meetingId]] : []),
            ...(event.passcode ? [["パスコード", event.passcode]] : []),
            ...(event.emergencyContact ? [["緊急連絡先", event.emergencyContact]] : []),
            ...(event.instructions ? [["案内・準備事項", event.instructions]] : []),
            ...(event.clientFeedback ? [[event.shareFeedback ? "先方評価（本人にも表示）" : "先方評価（本人には非表示）", event.clientFeedback]] : []),
          ] as [string, ReactNode][] : []),
        ]} />
        {!event.entry && <button type="button" className="detail-action" onClick={showNotice}>{!canEdit ? "面談日時・案内を見る" : event.result !== "pending" || event.status !== "scheduled" ? "先方評価・準備事項を編集" : !event.url ? "本面談URL・案内を登録" : "日時・案内を変更" }<Icon name="chevright" /></button>}
        <CaseMetadata item={event} includeRemarks />
        {!event.entry && <><p className="sales-result">面談結果：{event.result === "pending" ? "未登録" : interviewResultLabels[event.result]}</p><div className="sales-workflow-actions">{canEdit && (event.result === "pending" || event.result === "offered") && !entryEvent && <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "entry", eventId: event.key })}>面談結果・初回入場を登録<Icon name="chevright" /></button>}{canEdit && event.result === "pending" && (event.round || 1) < 5 && <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "next-round", eventId: event.key })}>通過・次回面談を依頼<Icon name="chevright" /></button>}{entryEvent && <button type="button" className="detail-action" onClick={() => showEvent(entryEvent)}>初回入場の予定を見る<Icon name="chevright" /></button>}</div></>}
      </section>
      {event.entry && <section className="file-section"><h3>当日の案内</h3><p className="body-copy sales-preserve-lines">{event.guidance || "当日の案内は未登録です。"}</p></section>}
      {event.entry && source && <section className="file-section sales-original-interview"><h3>元の面談</h3><Facts rows={[
        ["開始日時", <>{dateText(source.stamp)}<br /><span className="fact-time">{source.time}</span></>],
        ["面談区分", source.route],
        ["面談URL", <MeetingUrl url={source.url} />],
        ["面談所感", submittedFeedback ? "提出済み" : "未提出"],
      ]} /><div className="sales-workflow-actions"><button type="button" className="detail-action" onClick={() => showEvent(source)}>元の面談を見る<Icon name="chevright" /></button><button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "feedback", eventId: source.key })}>{submittedFeedback ? "所感・聞かれた質問を見る" : "所感の提出状況を見る"}<Icon name="chevright" /></button></div></section>}
      {!event.entry && <section className="file-section sales-feedback"><h3>面談所感</h3><p className="body-copy">{submittedFeedback ? `${submittedFeedback.person}さんが所感を提出しました。` : "受講者からの所感提出を待っています。"}</p>{submittedFeedback && <p className="body-copy">{submittedFeedback.impression}</p>}<button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "feedback", eventId: event.key })}>{submittedFeedback ? "所感・聞かれた質問を見る" : "提出状況を見る"}<Icon name="chevright" /></button></section>}
      <section className="file-section inspector-questions">
        <h3>この案件の過去質問<span className="question-count">{associated.length}</span></h3>
        {associated.length ? associated.map((q, i) => <details className="query" key={q.key}><summary><span className="q-no">Q{i + 1}</span><strong>{q.title}</strong><Icon name="chevright" /></summary><p>{q.context}</p></details>) : <p className="muted">登録された質問はありません。</p>}
      </section>
      <details className="file-foot" key={event.key}><summary>案件概要<Icon name="chevright" /></summary><p>{event.notes || "案件概要は未登録です。"}</p></details>
      {data && <section className="file-section"><h3>この面談者の面談履歴</h3><InterviewHistory data={data} projectId={event.projectId} studentId={event.studentId} onEvent={showEvent} /></section>}
      {back}
    </>;
  }

  return <>
    <a className="skip-link" href="#tab-title">本文へ移動</a>
    <header className="mast"><div className="mast-inner sales-mast">
      <button type="button" className="logo" onClick={() => selectView("schedule")} aria-label="DealHunter 予定表">
        {/* The supplied vector is the product's existing brand mark. */}
        <img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span>
      </button>
      <nav className="topnav" aria-label="メインメニュー">
        {([ ["schedule", "calendar", "予定表"], ["cases", "folder", "案件一覧"], ["engineers", "user", "エンジニア状況"], ["companyLookup", "check", "OK・NG検索"], ["tasks", "inbox", "対応待ち"], ["knowledge", "book", "質問集"] ] as const).map(([key, icon, label]) => <button type="button" key={key} className={`${view === key ? "active" : ""}${key === "tasks" ? " sales-task-nav" : ""}`} aria-current={view === key ? "page" : undefined} aria-label={key === "tasks" ? `対応待ち ${tasks.length}件／未確認 ${unreadTasks}件` : undefined} onClick={() => selectView(key)}><Icon name={icon} />{key === "tasks" ? <TaskCounts pending={tasks.length} unread={unreadTasks} /> : label}</button>)}
      </nav>
      <div className="account"><span className="division">営業部</span><span className="user-glyph" aria-hidden="true">{OWNER.slice(0, 1)}</span><span className="user-name">{OWNER}</span><form action={logout}><button type="submit" className="logout-btn">ログアウト</button></form></div>
    </div></header>
    <main>
      <div className="page-head"><div className="context"><span className="context-mark" />営業デスク<span className="sep">/</span>{view === "engineers" ? "全エンジニア" : view === "companyLookup" ? "面談担当" : "全営業の案件"}</div>
        <div className="title-row"><div><h1 id="tab-title" tabIndex={-1}>{title}</h1><p>{description}</p></div>
          <a className="new-btn" href={newInterviewRequestPath} target="_blank" rel="noopener" title="別タブで面談依頼を作成" aria-label="面談依頼を作成（別タブで開く）">
            面談依頼を作成<svg className="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M13 4h7v7m0-7L10 14M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5" /></svg>
          </a>
        </div>
      </div>
      {data && error && <p className="sales-refresh-error" role="alert">{error} <button type="button" className="text-link" onClick={() => void refresh()}>再読み込み</button></p>}
      {acknowledgeError && <p className="sales-refresh-error" role="alert">{acknowledgeError} <button type="button" className="text-link" onClick={() => { setAcknowledgeError(""); void refresh(); }}>最新の状態を確認</button></p>}
      {view === "engineers" ? <EngineerStatusList role="sales" /> :
        !data ? <div className="board loading-board"><div className="empty-state" role={error ? "alert" : "status"}><strong>{error || "予定を読み込んでいます…"}</strong>{error && <p><button type="button" className="text-link" onClick={() => void refresh()}>もう一度読み込む</button></p>}</div></div> :
        view === "cases" ? <CasePortfolio data={data} onWorkflow={openWorkflow} onEvent={showEvent} /> :
        view === "knowledge" ? <QuestionLibrary data={data} onEvent={showEvent} /> :
        view === "companyLookup" ? <div className="sales-company-lookup-screen"><InterviewerCompanyLookup snapshot={data.projects} /></div> : <div className="board">
          <aside className="rail" aria-label="日付と直近の予定">
            <div className="month-block"><div className="month-heading"><h2>{first.getUTCFullYear()}年 {first.getUTCMonth() + 1}月</h2><div className="month-controls">{([-1, 1] as const).map(offset => <button type="button" key={offset} aria-label={offset === -1 ? "前の月" : "次の月"} onClick={() => setMonth(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + offset, 1))}><Icon name={offset === -1 ? "left" : "right"} /></button>)}</div></div>
              <div className="weekdays" aria-hidden="true">{["月", "火", "水", "木", "金", "土", "日"].map(d => <span key={d}>{d}</span>)}</div>
              <div id="month-grid">{Array.from({ length: calendarLength }, (_, i) => {
                const stamp = firstVisible + i * DAY;
                const d = new Date(stamp);
                const at = events.filter(e => e.stamp === stamp);
                const chosen = view === "schedule" && event?.stamp === stamp;
                const classes = ["month-day", monthOf(stamp) !== month ? "out" : "", stamp === today ? "today" : "", stamp >= start && stamp < start + 7 * DAY ? "in-range" : "", chosen ? "selected-date" : ""].filter(Boolean).join(" ");
                return <button type="button" key={stamp} className={classes} aria-label={`${dateText(stamp)}からの7日間を表示、予定${at.length}件`} aria-current={stamp === today ? "date" : undefined} onClick={() => changeWindow(stamp)}><span>{d.getUTCDate()}</span>{at.length > 0 && <span className="dots" aria-hidden="true">{(["meet", "entry"] as const).filter(type => at.some(e => e.type === type)).map(type => <i className={`${type}-dot`} key={type} />)}</span>}</button>;
              })}</div>
              <div className="rail-today"><span className="legend"><i className="meet-key" />面談<i className="entry-key" />初回入場</span><button type="button" onClick={resetToday}>今日へ</button></div>
            </div>
            <div className="next-block"><h2>直近の確定予定</h2>
              <button type="button" className="jump jump-meet" disabled={!nextMeet} onClick={() => jump("meet")}><span className="jump-label">次の面談</span>{nextMeet ? <><span className="jump-time">{shortDate(nextMeet.stamp)} <small>{DAYS[new Date(nextMeet.stamp).getUTCDay()]}</small> <b>{nextMeet.time}</b></span><span className="jump-person">{nextMeet.person}<span>{nextMeet.mainKey ? "事前打合せ" : "本面談"}</span></span></> : <span className="jump-person">予定はありません</span>}<Icon name="arrow" /></button>
              <button type="button" className="jump jump-entry" disabled={!nextEntry} onClick={() => jump("entry")}><span className="jump-label">次の初回入場</span>{nextEntry ? <><span className="jump-time">{shortDate(nextEntry.stamp)} <small>{DAYS[new Date(nextEntry.stamp).getUTCDay()]}</small> <b>{nextEntry.time}</b></span><span className="jump-person">{nextEntry.person}<span>{nextEntry.format}</span></span></> : <span className="jump-person">予定はありません</span>}<Icon name="arrow" /></button>
            </div>
            <details className="sales-notifications"><summary>通知・カレンダーのプレビュー <span className="sales-request-count">{data.notifications.length}</span></summary>{data.notifications.length ? data.notifications.map(notification => <button type="button" key={notification.id} onClick={() => setDialog({ kind: "notification", notificationId: notification.id })}>{notification.kind === "calendar" ? "カレンダー" : "Lark通知"}：{notification.title}</button>) : <p>保存後に通知内容が表示されます。</p>}</details>
          </aside>
          <section className="workspace" aria-label="担当案件の予定一覧">
            {view === "schedule" && <div className="list-toolbar"><div className="type-tabs" aria-label="種類で絞り込み">{([ ["all", "すべて"], ["meet", "面談"], ["entry", "初回入場"] ] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => changeFilter(key)}>{label}</button>)}</div><div className="week-nav"><button type="button" aria-label="前の7日間" onClick={() => changeWindow(start - 7 * DAY)}><Icon name="left" /></button><b>{shortDate(start)} – {shortDate(start + 6 * DAY)}</b><button type="button" aria-label="次の7日間" onClick={() => changeWindow(start + 7 * DAY)}><Icon name="right" /></button></div></div>}
            <div id="agenda" ref={agendaRef}>
              {view === "schedule" && (list.length ? [...new Set(list.map(e => e.stamp))].map(stamp => <section className="day-group" key={stamp} aria-label={dateText(stamp)}><div className="date-stub"><span className="day-number">{pad(new Date(stamp).getUTCDate())}</span><span className="day-week">{DAYS[new Date(stamp).getUTCDay()]}曜日</span>{stamp === today + DAY && <span className="day-relative">明日</span>}</div><div className="day-events">{list.filter(e => e.stamp === stamp).map(e => <button type="button" key={e.key} className={`agenda-row${event?.key === e.key ? " selected" : ""}`} aria-pressed={event?.key === e.key} onClick={() => { setSelected(e.key); focusDetail(); }}><span className="row-time"><span className={`kind mark-${e.type}`}>{e.entry ? "初回入場" : e.mainKey ? "事前打合せ" : "本面談"}</span><time dateTime={`${new Date(e.stamp).toISOString().slice(0, 10)}T${e.time}:00+09:00`}>{e.time}</time></span><strong className="row-title">{e.project}</strong><span className="row-person">{e.person}<span className="row-sep"> · </span>{e.format}</span><span className="row-arrow"><Icon name="chevright" /></span></button>)}</div></section>) : <div className="empty-state"><strong>この期間の予定はありません</strong><p>期間や予定の種類を変更して確認できます。</p><button type="button" className="text-link" onClick={resetToday}>今日の予定表に戻る</button></div>)}
              {view === "tasks" && <>
                <div className="view-list-head sales-task-list-head"><strong>案件ごとの対応状況</strong><TaskCounts pending={tasks.length} unread={unreadTasks} /></div>
                {tasks.length ? tasks.map(t => <button type="button" key={t.key} className={`agenda-row auxiliary-row${task?.key === t.key ? " selected" : ""}${t.unread ? " sales-task-unread" : ""}`} aria-pressed={task?.key === t.key} onClick={() => selectTask(t)}>
                  <span className="row-time"><span className={`kind mark-${t.owner === "営業" ? "entry" : "meet"}`}>{t.owner}の対応</span></span><strong className="row-title">{t.title}<TaskReadBadge task={t} /></strong><span className="row-person">{t.project} · {t.person} · 担当営業：{projectsById.get(t.projectId)?.salesName}</span><span className="row-arrow"><Icon name="chevright" /></span>
                </button>) : <div className="empty-state"><strong>対応待ちはありません</strong><p>受講者の回答や提出があると、ここに表示されます。</p></div>}
                <div className="sales-request-list"><div className="view-list-head"><strong>作成した面談依頼</strong><span>{requests.length + pendingRecruitments.length}件</span></div>
                  {pendingRecruitments.map(item => <button className="sales-request-row sales-recruitment-row" type="button" key={`recruitment-${item.id}`} onClick={() => openWorkflow({ kind: "recruitment", recruitmentId: item.id })}><strong>{item.project}</strong><span>担当営業：{projectsById.get(item.projectId)?.salesName} · 面談者はリーダーが選定 · リーダー：{item.leaderName} · <span className="sales-status">面談者の選定待ち</span></span></button>)}
                  {requests.map(item => <button className="sales-request-row" type="button" key={item.id} onClick={() => openWorkflow({ kind: item.status === "responded" ? "confirm" : "request", requestId: item.id })}><strong>{item.project}</strong><span>{item.person} · 担当営業：{projectsById.get(item.projectId)?.salesName} · リーダー：{item.leaderName || "未設定"} · <span className="sales-status">{salesRequestState(item)}</span></span></button>)}
                  {!requests.length && !pendingRecruitments.length && <div className="empty-state"><p>面談依頼を作成すると表示されます。</p></div>}
                </div>
              </>}
            </div>
          </section>
          <aside id="inspector" className="inspector" ref={inspectorRef} tabIndex={-1} aria-label="選択した項目の詳細" key={`${view}-${view === "schedule" ? event?.key : task?.key}`}>
            {view === "schedule" && eventDetails()}
            {view === "tasks" && (task ? <>
              <FileHead reference={`対応待ち　/　${task.owner}`} title={task.project} status={task.title} />
              {task.action === "entry" && taskEvent && <section className="file-section"><h3>面談後の対応</h3><div className="sales-workflow-actions">
                <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "feedback", eventId: taskEvent.key })}>所感・聞かれた質問を見る<Icon name="chevright" /></button>
                <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "notice", eventId: taskEvent.key })}>{canEditTask ? "先方評価・準備事項を編集" : "先方評価・準備事項を見る"}<Icon name="chevright" /></button>
                {canEditTask && taskEvent.result === "pending" && (taskEvent.round || 1) < 5 && <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "next-round", eventId: taskEvent.key })}>通過・次回面談を依頼<Icon name="chevright" /></button>}
              </div></section>}
              <section className="file-section"><h3>対応内容<TaskReadBadge task={task} /></h3><Facts rows={[["上位会社", taskProject?.upperCompany || "未登録"], ["エンド企業", taskProject?.endCompany || "未入力"], ["面談者", task.action === "assign" ? "面談者はリーダーが選定" : task.person], ["参画者", taskProject?.participantName || "未登録"], ["参画者(ひらがな)", taskProject?.participantNameKana || "未登録"], ["リーダー", taskProject?.leaderName || "未設定"], ["次の担当", task.owner], ["担当営業", taskProject?.salesName]]} /><p className="body-copy">{task.body}</p><p className="sales-task-read-note">{canEditTask ? "内容を開くと確認済みになります。対応が完了すると一覧から外れます。" : "確認状態と更新は、この案件の担当営業が管理します。"}</p>{taskLink && <button type="button" className="detail-action" onClick={() => openWorkflow(taskLink.target)}>{taskLink.label}<Icon name="chevright" /></button>}</section>{back}
            </> : <><FileHead reference="対応待ち" title={tasks.length ? "対応する項目を選択" : "対応待ちはありません"} /><div className="empty-state"><p>{tasks.length ? "一覧の項目を開くと、対応内容を確認できます。" : "作成した面談依頼から、受講者の回答状況を確認できます。"}</p></div>{back}</>)}
          </aside>
        </div>}
    </main>
    {data && <PreviewDialog active={dialog} data={data} onClose={closeDialog} onSaved={refresh} />}
  </>;
}


