"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardData, ScheduleEvent, Task } from "../types";
import PreviewDialog, { type PreviewDialogKey } from "./PreviewDialog";
import { logout } from "../actions/auth";
import { entryForInterview, sourceInterview } from "../lib/interview-history";

type View = "schedule" | "tasks" | "knowledge";
type Filter = "all" | "meet" | "entry";
const DAY = 86400000;
const TODAY = Date.UTC(2026, 10, 5);
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const OWNER = "青木 美咲";
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
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [acknowledgeError, setAcknowledgeError] = useState("");
  const [view, setView] = useState<View>("schedule");
  const [filter, setFilter] = useState<Filter>("all");
  const [start, setStart] = useState(TODAY);
  const [month, setMonth] = useState(monthOf(TODAY));
  const [selected, setSelected] = useState("DH-1027");
  const [selectedTask, setSelectedTask] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState("Q-018");
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
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!active.current || sequence !== refreshSequence.current) return;
      if (response.status === 401) { window.location.assign("/login"); return; }
      if (!response.ok) throw new Error("予定を取得できませんでした。Java APIとPostgreSQLの起動を確認してください。");
      const updated = await response.json() as DashboardData;
      if (!active.current || sequence !== refreshSequence.current) return;
      if (updated.currentUser.role !== "sales") { window.location.assign(updated.currentUser.role === "leader" ? "/leader" : "/engineer"); return; }
      setData(updated); setError("");
    } catch (reason) { if (sequence === refreshSequence.current) setError(reason instanceof Error ? reason.message : "予定を取得できませんでした。"); }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisible);
    return () => { active.current = false; refreshSequence.current++; window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const acknowledgeTask = useCallback(async (target: Task) => {
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
    const requested = data.requests.find(item => item.id === params.get("request"));
    const scheduled = data.events.find(item => item.key === params.get("event"));
    if (requested) {
      const linkedTask = data.tasks.find(item => item.requestId === requested.id && item.action === "schedule");
      setView("tasks"); setSelectedTask(linkedTask?.key ?? "");
      if (linkedTask) void acknowledgeTask(linkedTask);
      setDialog({ kind: requested.status === "responded" ? "confirm" : "request", requestId: requested.id });
    } else if (scheduled) {
      setStart(scheduled.stamp); setMonth(monthOf(scheduled.stamp)); setSelected(scheduled.key); focusDetail();
      const linkedTask = data.tasks.find(item => item.eventId === scheduled.key && item.action === "entry") ?? data.tasks.find(item => item.eventId === scheduled.key);
      if (linkedTask) void acknowledgeTask(linkedTask);
    }
  }, [data, acknowledgeTask]);

  const closeDialog = useCallback(() => setDialog(null), []);
  const events = data?.events ?? [];
  const questions = data?.questions ?? [];
  const tasks = data?.tasks ?? [];
  const unreadTasks = tasks.filter(item => item.unread).length;
  const requests = data?.requests ?? [];
  const nextMeet = events.find(e => e.stamp >= TODAY && e.type === "meet");
  const nextEntry = events.find(e => e.stamp >= TODAY && e.type === "entry");
  const list = events.filter(e => e.stamp >= start && e.stamp < start + 7 * DAY && (filter === "all" || e.type === filter));
  const event = list.find(e => e.key === selected) ?? list[0];
  const task = tasks.find(t => t.key === selectedTask);
  const question = questions.find(q => q.key === selectedQuestion) ?? questions[0];
  const title = { schedule: "面談・入場予定", tasks: "対応待ち", knowledge: "質問集" }[view];

  function selectTask(target: Task) {
    setSelectedTask(target.key); focusDetail(); void acknowledgeTask(target);
  }

  function openWorkflow(target: PreviewDialogKey) {
    const action = target.kind === "confirm" ? "schedule" : target.kind === "entry" ? "entry" : target.kind === "feedback" ? "feedback" : undefined;
    const matching = action ? tasks.find(item => item.action === action && (target.eventId ? item.eventId === target.eventId : target.requestId ? item.requestId === target.requestId : false)) : undefined;
    if (matching) void acknowledgeTask(matching);
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

  function changeWindow(stamp: number) {
    setStart(stamp);
    setMonth(monthOf(stamp));
    setView("schedule");
    const next = events.filter(e => e.stamp >= stamp && e.stamp < stamp + 7 * DAY && (filter === "all" || e.type === filter));
    if (!next.some(e => e.key === selected)) setSelected(next[0]?.key ?? "");
  }

  function changeFilter(value: Filter) {
    setFilter(value);
    const next = events.filter(e => e.stamp >= start && e.stamp < start + 7 * DAY && (value === "all" || e.type === value));
    if (!next.some(e => e.key === selected)) setSelected(next[0]?.key ?? "");
  }

  function resetToday() {
    changeWindow(TODAY);
    setSelected("DH-1027");
    setFilter("all");
  }

  function showEvent(e: ScheduleEvent) {
    changeWindow(e.stamp);
    setFilter("all");
    setSelected(e.key);
    focusDetail();
  }

  function jump(type: "meet" | "entry") {
    const next = events.find(e => e.stamp >= TODAY && e.type === type);
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
    const associated = questions.filter(q => q.project === event.projectId);
    const source = sourceInterview(event, events);
    const submittedFeedback = data?.feedbacks.find(item => item.eventId === source?.key);
    const entryEvent = entryForInterview(event, events);
    return <>
      <FileHead reference={`案件詳細　/　${event.projectId}`} title={event.project} status={`${event.route}　${event.result === "rejected" ? "不合格" : "確定"}`} art={event.projectId === "DH-1027"} />
      <section className="file-section">
        <h3>{event.entry ? "初回入場の予定" : "面談の予定"}</h3>
        <Facts rows={[
          [event.entry ? "集合時刻" : "日時", <>{dateText(event.stamp)}<br /><span className="fact-time">{event.time}{event.end ? ` – ${event.end}` : " 集合"}</span></>],
          ["面談者", event.person],
          ["参画者", event.participantName || "未登録"],
          ["参画者(ひらがな)", event.participantNameKana || "未登録"],
          ["リーダー", event.leaderName || "未設定"],
          [event.entry ? "集合場所" : "実施形式", event.format],
          ["担当営業", OWNER],
          ...(!event.entry ? [["面談URL", <MeetingUrl url={event.url} />] as [string, ReactNode]] : []),
        ]} />
        {!event.entry && <><p className="sales-result">面談結果：{{ pending: "未登録", passed: "合格", rejected: "不合格" }[event.result]}</p><div className="sales-workflow-actions">{event.result === "pending" && <button type="button" className="detail-action" onClick={() => openWorkflow({ kind: "entry", eventId: event.key })}>面談結果・初回入場を登録<Icon name="chevright" /></button>}{entryEvent && <button type="button" className="detail-action" onClick={() => showEvent(entryEvent)}>初回入場の予定を見る<Icon name="chevright" /></button>}</div></>}
      </section>
      {event.entry && <section className="file-section"><h3>当日の案内</h3><p className="body-copy sales-preserve-lines">{event.guidance || "当日の案内は未登録です。"}</p></section>}
      {event.entry && source && <section className="file-section sales-original-interview"><h3>元の面談</h3><Facts rows={[
        ["日時", <>{dateText(source.stamp)}<br /><span className="fact-time">{source.time}{source.end ? ` – ${source.end}` : ""}</span></>],
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
      {back}
    </>;
  }

  return <>
    <a className="skip-link" href="#tab-title">本文へ移動</a>
    <header className="mast"><div className="mast-inner">
      <button type="button" className="logo" onClick={() => setView("schedule")} aria-label="DealHunter 予定表">
        {/* The supplied vector is the product's existing brand mark. */}
        <img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span>
      </button>
      <nav className="topnav" aria-label="メインメニュー">
        {([ ["schedule", "calendar", "予定表"], ["tasks", "inbox", "対応待ち"], ["knowledge", "book", "質問集"] ] as const).map(([key, icon, label]) => <button type="button" key={key} className={`${view === key ? "active" : ""}${key === "tasks" ? " sales-task-nav" : ""}`} aria-current={view === key ? "page" : undefined} aria-label={key === "tasks" ? `対応待ち ${tasks.length}件／未確認 ${unreadTasks}件` : undefined} onClick={() => setView(key)}><Icon name={icon} />{key === "tasks" ? <TaskCounts pending={tasks.length} unread={unreadTasks} /> : label}</button>)}
      </nav>
      <div className="account"><span className="division">営業部</span><span className="user-glyph" aria-hidden="true">青</span><span className="user-name">{OWNER}</span><form action={logout}><button type="submit" className="logout-btn">ログアウト</button></form></div>
    </div></header>
    <main>
      <div className="page-head"><div className="context"><span className="context-mark" />営業デスク<span className="sep">/</span>自分の担当案件</div>
        <div className="title-row"><div><h1 id="tab-title" tabIndex={-1}>{title}</h1><p>{view === "schedule" ? "2026年11月5日（木）" : view === "tasks" ? "担当案件と、次に対応する人を確認できます。" : "過去の面談で聞かれた質問を案件ごとに確認できます。"}</p></div><button type="button" className="new-btn" onClick={() => setDialog({ kind: "new" })}><Icon name="plus" />面談依頼を作成</button></div>
      </div>
      {data && error && <p className="sales-refresh-error" role="alert">{error} <button type="button" className="text-link" onClick={() => void refresh()}>再読み込み</button></p>}
      {acknowledgeError && <p className="sales-refresh-error" role="alert">{acknowledgeError} <button type="button" className="text-link" onClick={() => { setAcknowledgeError(""); void refresh(); }}>最新の状態を確認</button></p>}
      {!data ? <div className="board loading-board"><div className="empty-state" role={error ? "alert" : "status"}><strong>{error || "予定を読み込んでいます…"}</strong>{error && <p><button type="button" className="text-link" onClick={() => void refresh()}>もう一度読み込む</button></p>}</div></div> :
        <div className="board">
          <aside className="rail" aria-label="日付と直近の予定">
            <div className="month-block"><div className="month-heading"><h2>{first.getUTCFullYear()}年 {first.getUTCMonth() + 1}月</h2><div className="month-controls">{([-1, 1] as const).map(offset => <button type="button" key={offset} aria-label={offset === -1 ? "前の月" : "次の月"} onClick={() => setMonth(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + offset, 1))}><Icon name={offset === -1 ? "left" : "right"} /></button>)}</div></div>
              <div className="weekdays" aria-hidden="true">{["月", "火", "水", "木", "金", "土", "日"].map(d => <span key={d}>{d}</span>)}</div>
              <div id="month-grid">{Array.from({ length: calendarLength }, (_, i) => {
                const stamp = firstVisible + i * DAY;
                const d = new Date(stamp);
                const at = events.filter(e => e.stamp === stamp);
                const chosen = view === "schedule" && event?.stamp === stamp;
                const classes = ["month-day", monthOf(stamp) !== month ? "out" : "", stamp === TODAY ? "today" : "", stamp >= start && stamp < start + 7 * DAY ? "in-range" : "", chosen ? "selected-date" : ""].filter(Boolean).join(" ");
                return <button type="button" key={stamp} className={classes} aria-label={`${dateText(stamp)}からの7日間を表示、予定${at.length}件`} aria-current={stamp === TODAY ? "date" : undefined} onClick={() => changeWindow(stamp)}><span>{d.getUTCDate()}</span>{at.length > 0 && <span className="dots" aria-hidden="true">{(["meet", "entry"] as const).filter(type => at.some(e => e.type === type)).map(type => <i className={`${type}-dot`} key={type} />)}</span>}</button>;
              })}</div>
              <div className="rail-today"><span className="legend"><i className="meet-key" />面談<i className="entry-key" />初回入場</span><button type="button" onClick={resetToday}>今日へ</button></div>
            </div>
            <div className="next-block"><h2>直近の確定予定</h2>
              <button type="button" className="jump jump-meet" disabled={!nextMeet} onClick={() => jump("meet")}><span className="jump-label">次の面談</span>{nextMeet ? <><span className="jump-time">{shortDate(nextMeet.stamp)} <small>{DAYS[new Date(nextMeet.stamp).getUTCDay()]}</small> <b>{nextMeet.time}</b></span><span className="jump-person">{nextMeet.person}<span>{nextMeet.format}</span></span></> : <span className="jump-person">予定はありません</span>}<Icon name="arrow" /></button>
              <button type="button" className="jump jump-entry" disabled={!nextEntry} onClick={() => jump("entry")}><span className="jump-label">次の初回入場</span>{nextEntry ? <><span className="jump-time">{shortDate(nextEntry.stamp)} <small>{DAYS[new Date(nextEntry.stamp).getUTCDay()]}</small> <b>{nextEntry.time}</b></span><span className="jump-person">{nextEntry.person}<span>{nextEntry.format}</span></span></> : <span className="jump-person">予定はありません</span>}<Icon name="arrow" /></button>
            </div>
            <details className="sales-notifications"><summary>通知・カレンダーのプレビュー <span className="sales-request-count">{data.notifications.length}</span></summary>{data.notifications.length ? data.notifications.map(notification => <button type="button" key={notification.id} onClick={() => setDialog({ kind: "notification", notificationId: notification.id })}>{notification.kind === "calendar" ? "カレンダー" : "Lark通知"}：{notification.title}</button>) : <p>保存後に通知内容が表示されます。</p>}</details>
          </aside>
          <section className="workspace" aria-label="担当案件の予定一覧">
            {view === "schedule" && <div className="list-toolbar"><div className="type-tabs" aria-label="種類で絞り込み">{([ ["all", "すべて"], ["meet", "面談"], ["entry", "初回入場"] ] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => changeFilter(key)}>{label}</button>)}</div><div className="week-nav"><button type="button" aria-label="前の7日間" onClick={() => changeWindow(start - 7 * DAY)}><Icon name="left" /></button><b>{shortDate(start)} – {shortDate(start + 6 * DAY)}</b><button type="button" aria-label="次の7日間" onClick={() => changeWindow(start + 7 * DAY)}><Icon name="right" /></button></div></div>}
            <div id="agenda" ref={agendaRef}>
              {view === "schedule" && (list.length ? [...new Set(list.map(e => e.stamp))].map(stamp => <section className="day-group" key={stamp} aria-label={dateText(stamp)}><div className="date-stub"><span className="day-number">{pad(new Date(stamp).getUTCDate())}</span><span className="day-week">{DAYS[new Date(stamp).getUTCDay()]}曜日</span>{stamp === TODAY + DAY && <span className="day-relative">明日</span>}</div><div className="day-events">{list.filter(e => e.stamp === stamp).map(e => <button type="button" key={e.key} className={`agenda-row${event?.key === e.key ? " selected" : ""}`} aria-pressed={event?.key === e.key} onClick={() => { setSelected(e.key); focusDetail(); }}><span className="row-time"><span className={`kind mark-${e.type}`}>{e.entry ? "初回入場" : "面談"}</span><time dateTime={`${new Date(e.stamp).toISOString().slice(0, 10)}T${e.time}:00+09:00`}>{e.time}</time></span><strong className="row-title">{e.project}</strong><span className="row-person">{e.person}<span className="row-sep"> · </span>{e.format}</span><span className="row-arrow"><Icon name="chevright" /></span></button>)}</div></section>) : <div className="empty-state"><strong>この期間の予定はありません</strong><p>期間や予定の種類を変更して確認できます。</p><button type="button" className="text-link" onClick={resetToday}>今日の予定表に戻る</button></div>)}
              {view === "tasks" && <>
                <div className="view-list-head sales-task-list-head"><strong>案件ごとの対応状況</strong><TaskCounts pending={tasks.length} unread={unreadTasks} /></div>
                {tasks.length ? tasks.map(t => <button type="button" key={t.key} className={`agenda-row auxiliary-row${task?.key === t.key ? " selected" : ""}${t.unread ? " sales-task-unread" : ""}`} aria-pressed={task?.key === t.key} onClick={() => selectTask(t)}>
                  <span className="row-time"><span className={`kind mark-${t.owner === "営業" ? "entry" : "meet"}`}>{t.owner}の対応</span></span><strong className="row-title">{t.title}<TaskReadBadge task={t} /></strong><span className="row-person">{t.project} · {t.person}</span><span className="row-arrow"><Icon name="chevright" /></span>
                </button>) : <div className="empty-state"><strong>対応待ちはありません</strong><p>受講者の回答や提出があると、ここに表示されます。</p></div>}
                <div className="sales-request-list"><div className="view-list-head"><strong>作成した面談依頼</strong><span>{requests.length}件</span></div>{requests.length ? requests.map(item => <button className="sales-request-row" type="button" key={item.id} onClick={() => openWorkflow({ kind: item.status === "responded" ? "confirm" : "request", requestId: item.id })}><strong>{item.project}</strong><span>{item.person} · リーダー：{item.leaderName || "未設定"} · <span className="sales-status">{{ requested: "受講者の回答待ち", responded: "回答済み・日時確定待ち", confirmed: "日時確定済み" }[item.status]}</span></span></button>) : <div className="empty-state"><p>面談依頼を作成すると表示されます。</p></div>}</div>
              </>}
              {view === "knowledge" && <><div className="view-list-head"><strong>面談で聞かれた質問</strong><span>{questions.length}件</span></div>{questions.length ? questions.map(q => <button type="button" key={q.key} className={`agenda-row auxiliary-row${question?.key === q.key ? " selected" : ""}`} aria-pressed={question?.key === q.key} onClick={() => { setSelectedQuestion(q.key); focusDetail(); }}><span className="row-time"><span className="kind mark-meet">{q.tag}</span></span><strong className="row-title">{q.title}</strong><span className="row-person">{events.find(e => e.projectId === q.project)?.project ?? requests.find(r => r.projectId === q.project)?.project}</span><span className="row-arrow"><Icon name="chevright" /></span></button>) : <div className="empty-state"><p>面談後に提出された質問が表示されます。</p></div>}</>}
            </div>
          </section>
          <aside id="inspector" className="inspector" ref={inspectorRef} tabIndex={-1} aria-label="選択した項目の詳細" key={`${view}-${view === "schedule" ? event?.key : view === "tasks" ? task?.key : question?.key}`}>
            {view === "schedule" && eventDetails()}
            {view === "tasks" && (task ? <>
              <FileHead reference={`対応待ち　/　${task.owner}`} title={task.project} status={task.title} />
              <section className="file-section"><h3>対応内容<TaskReadBadge task={task} /></h3><Facts rows={[["面談者", task.person], ["参画者", data?.projects?.find(item => item.id === task.projectId)?.participantName || "未登録"], ["参画者(ひらがな)", data?.projects?.find(item => item.id === task.projectId)?.participantNameKana || "未登録"], ["リーダー", data?.projects?.find(item => item.id === task.projectId)?.leaderName || "未設定"], ["次の担当", task.owner], ["担当営業", OWNER]]} /><p className="body-copy">{task.body}</p><p className="sales-task-read-note">確認済みは内容を閲覧した状態です。対応が完了すると、この一覧から外れます。</p><button type="button" className="detail-action" onClick={() => openWorkflow({ kind: task.action === "schedule" ? "confirm" : task.action === "entry" ? "entry" : "feedback", requestId: task.requestId ?? undefined, eventId: task.eventId ?? undefined })}>{task.action === "feedback" ? "提出状況を見る" : task.action === "schedule" ? "面談日時を確定" : "面談結果・初回入場を登録"}<Icon name="chevright" /></button></section>{back}
            </> : <><FileHead reference="対応待ち" title={tasks.length ? "対応する項目を選択" : "対応待ちはありません"} /><div className="empty-state"><p>{tasks.length ? "一覧の項目を開くと、対応内容を確認できます。" : "作成した面談依頼から、受講者の回答状況を確認できます。"}</p></div>{back}</>)}
            {view === "knowledge" && question && <><FileHead reference={`質問集　/　${question.key}`} title={question.title} /><section className="file-section"><h3>質問の記録</h3><Facts rows={[["案件", events.find(e => e.projectId === question.project)?.project ?? requests.find(r => r.projectId === question.project)?.project], ["分類", question.tag]]} /><p className="body-copy">{question.context}</p>{events.some(e => e.projectId === question.project) && <button type="button" className="detail-action" onClick={() => { const target = events.find(e => e.key === question.eventId && e.projectId === question.project) ?? events.find(e => e.projectId === question.project); if (target) showEvent(target); }}>この案件の予定を見る<Icon name="chevright" /></button>}</section>{back}</>}
          </aside>
        </div>}
    </main>
    {data && <PreviewDialog active={dialog} data={data} onClose={closeDialog} onSaved={refresh} />}
  </>;
}


