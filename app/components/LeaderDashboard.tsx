"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { logout } from "../actions/auth";
import type { DemoUser } from "../lib/demo-auth";
import { sourceInterview } from "../lib/interview-history";
import type { DashboardData, InterviewFeedback, InterviewRequest, Project, ScheduleEvent } from "../types";

type StageGroup = "preparation" | "meeting" | "entry" | "active" | "closed";
type Stage = { label: string; group: StageGroup };
type Member = { id: string; name: string; requests: InterviewRequest[]; events: ScheduleEvent[] };
const groups: ["all" | StageGroup, string][] = [["all", "すべての状態"], ["preparation", "日程調整中"], ["meeting", "面談・結果待ち"], ["entry", "初回入場前"], ["active", "入場中"], ["closed", "見送り"]];
const resultLabels = { pending: "結果未登録", passed: "合格", rejected: "不合格" };
const requestLabels = { requested: "候補日時への回答待ち", responded: "回答済み・日時確定待ち", confirmed: "面談日時確定済み" };
const dateLabel = (stamp: number) => new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(stamp);
function dateTimeLabel(value: string) {
  const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value.replace(" ", "T")}+09:00` : value;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date);
}
const eventTime = (event: ScheduleEvent) => `${dateLabel(event.stamp)} ${event.time}${event.end ? `〜${event.end}` : ""}`;

function Icon({ name }: { name: string }) {
  return <svg className="icon" aria-hidden="true" focusable="false"><use href={`/icons.svg#i-${name}`} /></svg>;
}
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="dh-leader-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function MeetingUrl({ url }: { url: string }) {
  return /^https?:\/\//i.test(url) ? <a className="dh-leader-link" href={url} target="_blank" rel="noopener noreferrer">{url}<span>別タブで開く <Icon name="right" /></span></a> : <>未登録</>;
}
function Status({ stage }: { stage: Stage }) {
  return <span className={`dh-leader-status is-${stage.group}`}>{stage.label}</span>;
}
function membersOf(projectId: string, data: DashboardData): Member[] {
  const people = new Map<string, Member>();
  for (const request of data.requests.filter(item => item.projectId === projectId)) {
    if (!people.has(request.studentId)) people.set(request.studentId, { id: request.studentId, name: request.person, requests: [], events: [] });
    people.get(request.studentId)!.requests.push(request);
  }
  for (const event of data.events.filter(item => item.projectId === projectId)) {
    if (!people.has(event.studentId)) people.set(event.studentId, { id: event.studentId, name: event.person, requests: [], events: [] });
    people.get(event.studentId)!.events.push(event);
  }
  return [...people.values()];
}
function stageOf(member: Member, feedbacks: InterviewFeedback[]): Stage {
  const entry = member.events.filter(item => item.entry).at(-1);
  if (entry) return entry.engineerConfirmedAt ? { label: "入場中", group: "active" } : { label: "初回入場予定", group: "entry" };
  const meeting = member.events.filter(item => !item.entry).at(-1);
  if (meeting?.result === "rejected") return { label: "見送り", group: "closed" };
  if (meeting?.result === "passed") return { label: "初回入場登録待ち", group: "entry" };
  if (meeting) return feedbacks.some(item => item.eventId === meeting.key) ? { label: "営業の結果確認待ち", group: "meeting" } : { label: "面談確定・所感待ち", group: "meeting" };
  return member.requests.at(-1)?.status === "responded" ? { label: "日時確定待ち", group: "preparation" } : { label: "候補回答待ち", group: "preparation" };
}
function FeedbackRecord({ feedback }: { feedback: InterviewFeedback | undefined }) {
  return feedback ? <div className="dh-leader-feedback-record"><Facts rows={[["提出日時", dateTimeLabel(feedback.submittedAt)], ["業務内容", feedback.duties], ["作業工程", feedback.process], ["リモート頻度", feedback.remote], ["感想", feedback.impression]]} /><h5>聞かれた質問 <span>{feedback.questions.length}件</span></h5>{feedback.questions.length ? <ol>{feedback.questions.map((question, index) => <li key={index}>{question}</li>)}</ol> : <p className="dh-leader-muted">質問の記録はありません。</p>}</div> : <p className="dh-leader-muted">面談者からの所感提出を待っています。</p>;
}
function MemberRecord({ member, data, initiallyOpen }: { member: Member; data: DashboardData; initiallyOpen: boolean }) {
  const stage = stageOf(member, data.feedbacks);
  return <details className="dh-leader-member" open={initiallyOpen}>
    <summary><span className="dh-leader-member-person"><Icon name="user" /><strong>{member.name}</strong></span><Status stage={stage} /><Icon name="chevright" /></summary>
    <div className="dh-leader-member-body">
      {member.requests.map((request, index) => <section className="dh-leader-record" key={request.id}><h4><Icon name="inbox" />面談依頼{member.requests.length > 1 ? ` ${index + 1}` : ""}</h4><p className="dh-leader-record-state">{requestLabels[request.status]}</p><details className="dh-leader-fold"><summary>候補日時と回答を確認 <Icon name="chevright" /></summary><ul className="dh-leader-candidates">{request.candidates.map(slot => <li key={slot.id}><span>{dateTimeLabel(slot.start)} 〜 {dateTimeLabel(slot.end)}</span><b>{request.confirmedSlotId === slot.id ? "確定" : request.availableSlotIds.includes(slot.id) ? "参加可能" : request.status === "requested" ? "回答待ち" : "選択なし"}</b></li>)}</ul></details></section>)}
      {member.events.filter(item => !item.entry).map(meeting => <section className="dh-leader-record" key={meeting.key}><h4><Icon name="calendar" />{meeting.route || "面談"}</h4><Facts rows={[["面談日時", eventTime(meeting)], ["実施形式", meeting.format], ["面談URL", <MeetingUrl url={meeting.url} />], ["面談結果", <span className={`dh-leader-result is-${meeting.result}`}>{resultLabels[meeting.result]}</span>], ["本人の結果確認", meeting.engineerConfirmedAt ? dateTimeLabel(meeting.engineerConfirmedAt) : "未確認"]]} /><details className="dh-leader-fold"><summary>所感・聞かれた質問{data.feedbacks.some(item => item.eventId === meeting.key) ? "（提出済み）" : "（未提出）"}<Icon name="chevright" /></summary><FeedbackRecord feedback={data.feedbacks.find(item => item.eventId === meeting.key)} /></details></section>)}
      {member.events.filter(item => item.entry).map(entry => {
        const interview = sourceInterview(entry, data.events);
        return <section className="dh-leader-record is-entry" key={entry.key}><h4><Icon name="brief" />{entry.engineerConfirmedAt ? "入場中・初回入場の記録" : "初回入場予定"}</h4><Facts rows={[["集合日時", eventTime(entry)], ["集合場所", entry.format || "未登録"], ["当日の案内", entry.guidance || "案内は未登録です。"], ["入場完了の確認", entry.engineerConfirmedAt ? dateTimeLabel(entry.engineerConfirmedAt) : "未確認"]]} />{interview && <details className="dh-leader-fold"><summary>元の面談・所感を参照 <Icon name="chevright" /></summary><Facts rows={[["面談日時", eventTime(interview)], ["面談URL", <MeetingUrl url={interview.url} />], ["面談結果", resultLabels[interview.result]]]} /><FeedbackRecord feedback={data.feedbacks.find(item => item.eventId === interview.key)} /></details>}</section>;
      })}
      {!member.requests.length && !member.events.length && <p className="dh-leader-muted">面談情報はまだ登録されていません。</p>}
    </div>
  </details>;
}

export default function LeaderDashboard({ user }: { user: DemoUser }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<"all" | StageGroup>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const sequence = useRef(0);
  const initialLink = useRef(false);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++sequence.current;
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal });
      if (!active.current || version !== sequence.current) return;
      if (response.status === 401) { window.location.assign("/login"); return; }
      const updated = await response.json() as DashboardData & { error?: string };
      if (!active.current || version !== sequence.current) return;
      if (!response.ok) throw new Error(updated.error || "担当案件を取得できませんでした。もう一度お試しください。");
      if (updated.currentUser.role !== "leader" || updated.currentUser.id !== user.id) {
        setData(null);
        window.location.replace(updated.currentUser.role === "sales" ? "/sales" : updated.currentUser.role === "student" ? "/engineer" : "/leader");
        return;
      }
      if (!Array.isArray(updated.projects)) throw new Error("案件データを取得できませんでした。Java APIの起動を確認してください。");
      setData(updated); setError("");
      if (!initialLink.current) {
        initialLink.current = true;
        const requested = new URLSearchParams(window.location.search).get("project");
        if (requested && !updated.projects.some(project => project.id === requested)) {
          setNotice("指定された案件は表示できません。担当案件から選択してください。"); setSelectedId("");
        } else {
          setSelectedId(requested || updated.projects[0]?.id || "");
          if (requested) requestAnimationFrame(() => { if (window.matchMedia("(max-width: 800px)").matches) { detailRef.current?.scrollIntoView({ block: "start" }); detailRef.current?.focus({ preventScroll: true }); } });
        }
      }
    } catch (reason) {
      if (active.current && version === sequence.current && !signal?.aborted) setError(reason instanceof Error ? reason.message : "担当案件を取得できませんでした。");
    } finally { if (active.current && version === sequence.current) setLoading(false); }
  }, [user.id]);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisible);
    return () => { active.current = false; sequence.current++; controller.abort(); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);

  const projects = data?.projects ?? [];
  const records = data ? projects.map(project => ({ project, members: membersOf(project.id, data) })) : [];
  const search = query.trim().toLocaleLowerCase("ja-JP");
  const visible = records.filter(record => (!search || `${record.project.name} ${record.members.map(member => member.name).join(" ")}`.toLocaleLowerCase("ja-JP").includes(search)) && (group === "all" || record.members.some(member => stageOf(member, data?.feedbacks ?? []).group === group)));
  const selected = visible.find(record => record.project.id === selectedId);
  const activeProjects = records.filter(record => record.members.some(member => stageOf(member, data?.feedbacks ?? []).group === "active")).length;
  const people = new Set(records.flatMap(record => record.members.map(member => member.id))).size;

  function choose(project: Project) {
    setSelectedId(project.id); setNotice("");
    requestAnimationFrame(() => { if (window.matchMedia("(max-width: 800px)").matches) { detailRef.current?.scrollIntoView({ block: "start" }); detailRef.current?.focus({ preventScroll: true }); } });
  }
  function backToList() {
    listRef.current?.scrollIntoView({ block: "start" });
    (listRef.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]") ?? headingRef.current)?.focus({ preventScroll: true });
  }

  return <>
    <a className="skip-link" href="#dh-leader-title">本文へ移動</a>
    <header className="mast"><div className="dh-leader-mast"><a className="logo" href="/leader" aria-label="DealHunter リーダーホーム"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></a><nav className="topnav" aria-label="リーダーメニュー"><button type="button" className="active" aria-current="page" onClick={() => { headingRef.current?.scrollIntoView({ block: "start" }); headingRef.current?.focus({ preventScroll: true }); }}><Icon name="folder" />担当案件<span className="nav-count">{projects.length}</span></button></nav><div className="dh-leader-account"><span className="dh-leader-role">リーダー</span><strong>{user.name}</strong><form action={logout}><button type="submit" className="logout-btn">ログアウト</button></form></div></div></header>
    <main className="dh-leader-main"><div className="dh-leader-page-head"><p className="context"><span className="context-mark" />リーダーデスク<span className="sep">/</span>自分の担当案件</p><div className="dh-leader-title-row"><div><h1 id="dh-leader-title" ref={headingRef} tabIndex={-1}>担当案件</h1><p>リーダーに設定されている案件の進捗と内容を確認できます。</p></div><button type="button" className="dh-leader-refresh" disabled={loading} onClick={() => void refresh()}>{loading ? "更新中…" : "更新"}</button></div><div className="dh-leader-summary"><span>担当案件 <b>{projects.length}</b>件</span><span>面談者 <b>{people}</b>名</span><span>入場中 <b>{activeProjects}</b>件</span><small>閲覧のみ</small></div></div>
      {error && <div ref={errorRef} tabIndex={-1} className="dh-leader-message is-error" role="alert">{error}<button type="button" disabled={loading} onClick={() => void refresh()}>再読み込み</button></div>}
      {notice && <p className="dh-leader-message" role="status">{notice}</p>}
      {loading && !data ? <div className="dh-leader-loading" role="status">担当案件を読み込んでいます…</div> : <div className="dh-leader-board">
        <section className="dh-leader-list-panel" aria-label="担当案件一覧"><div className="dh-leader-filters"><label htmlFor="dh-leader-search">案件名・面談者で検索<input id="dh-leader-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="案件名・面談者で検索" /></label><label htmlFor="dh-leader-filter">状態で絞り込み<select id="dh-leader-filter" value={group} onChange={event => setGroup(event.target.value as "all" | StageGroup)}>{groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div><div className="dh-leader-list-head"><strong>担当案件の一覧</strong><span>{visible.length} / {projects.length}件</span></div><div ref={listRef} className="dh-leader-project-list">{visible.map(record => <button type="button" className={`dh-leader-project-row${selected?.project.id === record.project.id ? " selected" : ""}`} key={record.project.id} aria-pressed={selected?.project.id === record.project.id} onClick={() => choose(record.project)}><span className="dh-leader-row-title"><strong>{record.project.name}</strong><Icon name="chevright" /></span><span className="dh-leader-row-sales">担当営業 {record.project.salesName} <i>·</i> 面談者 {record.members.length}名</span><span className="dh-leader-row-members">{record.members.map(member => <span key={member.id}><b>{member.name}</b><Status stage={stageOf(member, data?.feedbacks ?? [])} /></span>)}{!record.members.length && <span className="dh-leader-muted">面談情報はまだありません。</span>}</span></button>)}{!visible.length && <div className="dh-leader-empty"><Icon name="folder" /><h2>{projects.length ? "該当する案件はありません" : "担当案件はまだありません"}</h2><p>{projects.length ? "検索条件や状態の絞り込みを変更してください。" : "営業が案件のリーダーに設定すると、ここに表示されます。"}</p></div>}</div></section>
        <aside ref={detailRef} className="dh-leader-detail" tabIndex={-1} aria-label="選択した案件の詳細">{selected && data ? <><div className="dh-leader-detail-head"><p><Icon name="folder" />担当案件</p><h2>{selected.project.name}</h2><Facts rows={[["担当営業", selected.project.salesName], ["リーダー", selected.project.leaderName || user.name], ["面談者", `${selected.members.length}名`], ["参画者", selected.project.participantName || "未登録"], ["参画者(ひらがな)", selected.project.participantNameKana || "未登録"]]} /></div><section className="dh-leader-section"><h3>案件概要</h3><p className="dh-leader-body">{selected.project.notes || "案件概要はまだ登録されていません。"}</p></section><section className="dh-leader-section dh-leader-members-section"><h3>面談者ごとの進捗 <span>{selected.members.length}名</span></h3><p className="dh-leader-muted">面談者を開くと、日程・所感・面談結果・入場状況を確認できます。</p>{selected.members.map((member, index) => <MemberRecord key={`${selected.project.id}-${member.id}`} member={member} data={data} initiallyOpen={index === 0} />)}{!selected.members.length && <p className="dh-leader-muted">面談情報はまだ登録されていません。</p>}</section><section className="dh-leader-section"><details className="dh-leader-knowledge"><summary>この案件の過去質問 <span>{data.questions.filter(question => question.project === selected.project.id).length}件</span><Icon name="chevright" /></summary>{data.questions.filter(question => question.project === selected.project.id).map((question, index) => <details className="dh-leader-question" key={question.key}><summary><b>Q{index + 1}</b>{question.title}<Icon name="chevright" /></summary><p>{question.context || "この案件の面談で聞かれた質問です。"}</p></details>)}</details></section><button type="button" className="dh-leader-back" onClick={backToList}><Icon name="left" />一覧へ戻る</button></> : <div className="dh-leader-empty"><Icon name="folder" /><h2>案件を選択してください</h2><p>一覧から案件を開くと、概要と面談者ごとの進捗を確認できます。</p></div>}</aside>
      </div>}
    </main>
  </>;
}
