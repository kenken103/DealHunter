"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { logout } from "../actions/auth";
import type { DemoUser } from "../lib/demo-auth";
import { sourceInterview } from "../lib/interview-history";
import type { DashboardData, InterviewFeedback, InterviewRequest, MutationResult, NotificationPreview, ScheduleEvent } from "../types";

type View = "schedule" | "requests" | "feedback" | "inProgress";
type Kind = "all" | "meet" | "entry";
type ReferenceOrigin = { view: "schedule" | "inProgress"; eventId: string };
type FeedbackValues = { duties: string; process: string; remote: string; impression: string; questions: string[] };
const requestLabels = { requested: "回答待ち", responded: "回答済み・日程調整中", confirmed: "日時確定" };
const dateLabel = (stamp: number) => new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(new Date(stamp));
const jstDate = (value: string) => new Date(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value.replace(" ", "T")}+09:00` : value);
const dateTimeLabel = (value: string) => {
  const date = jstDate(value);
  return Number.isNaN(date.getTime()) ? value.replace("T", " ") : new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date);
};
const slotLabel = (start: string, end: string | null) => end ? `${dateTimeLabel(start)} 〜 ${Number.isNaN(jstDate(end).getTime()) ? end : new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(jstDate(end))}` : dateTimeLabel(start);
const requestedDateLabel = (value: string) => dateLabel(Date.parse(`${value}T00:00:00Z`));
function previewValue(value: string) {
  const local = value.match(/^(?:http:\/\/(?:127\.0\.0\.1|localhost):3100)?(\/(?:engineer|sales)(?:\?[^\s]*)?)$/);
  return local ? <a href={local[1]}>{value}</a> : value;
}

function Icon({ name }: { name: string }) {
  return <svg className="icon" aria-hidden="true" focusable="false"><use href={`/icons.svg#i-${name}`} /></svg>;
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="dh-engineer-facts">{rows.map(([label, value], index) => <div key={`${label}-${index}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="dh-engineer-empty"><Icon name="calendar" /><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}

function AttachmentSection({ request, showEmpty = false }: { request?: InterviewRequest; showEmpty?: boolean }) {
  if (!request || (!request.attachment && !showEmpty)) return null;
  return <section className="dh-engineer-section"><h3>スキルシート</h3>{request.attachment ? <><p className="dh-engineer-body">{request.attachment.name}</p><a className="dh-engineer-secondary dh-engineer-attachment-link" href={`/api/requests/${encodeURIComponent(request.id)}/attachment`} download>スキルシートをダウンロード<Icon name="arrow" /></a></> : <p className="dh-engineer-small">スキルシートは添付されていません。</p>}</section>;
}

function PreviewModal({ preview, onClose }: { preview: NotificationPreview | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!preview) { if (dialog.open) dialog.close(); return; }
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    headingRef.current?.focus({ preventScroll: true });
    dialog.scrollTop = 0;
  }, [preview]);
  return <dialog ref={dialogRef} className="dh-engineer-preview" aria-labelledby="dh-engineer-preview-title" onClose={() => {
    onClose();
    const target = openerRef.current?.isConnected ? openerRef.current : document.getElementById("dh-engineer-title");
    target?.focus({ preventScroll: true });
  }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
  }}>
    <div className="dialog-chrome"><strong>DealHunter</strong><button type="button" aria-label="プレビューを閉じる" onClick={() => dialogRef.current?.close()}><Icon name="x" /></button></div>
    <div className="dh-engineer-preview-body"><p className="dh-engineer-eyebrow">通知・カレンダーのプレビュー</p><h2 ref={headingRef} tabIndex={-1} id="dh-engineer-preview-title">{preview?.title}</h2>{preview && <Facts rows={preview.lines.map(line => [line.label, previewValue(line.value)])} />}{preview?.body && <p className="dh-engineer-preview-message">{preview.body}</p>}<p className="dh-engineer-small">通知内容の確認用です。Larkへの送信やカレンダー登録は行いません。</p><button type="button" className="dh-engineer-primary" onClick={() => dialogRef.current?.close()}>閉じる</button></div>
  </dialog>;
}

type ResponseProps = { request: InterviewRequest; pending: boolean; onSave: (path: string, payload: object) => Promise<boolean> };
type AvailabilityDraft = { key: number; date: string; time: string };

function AvailabilityResponse({ request, pending, onSave }: ResponseProps) {
  const dates = request.requestedDates ?? [];
  const [drafts, setDrafts] = useState<AvailabilityDraft[]>(() => {
    const answers = request.candidates.filter(slot => request.availableSlotIds.includes(slot.id));
    return answers.length ? answers.map((slot, key) => ({ key, date: slot.start.slice(0, 10), time: slot.start.slice(11, 16) })) : [{ key: 0, date: dates[0] ?? "", time: "" }];
  });
  const sequence = useRef(drafts.length);
  const dateFields = useRef(new Map<number, HTMLInputElement | HTMLSelectElement>());
  const [error, setError] = useState("");

  function addDraft() {
    const key = sequence.current++;
    setDrafts(current => [...current, { key, date: dates[0] ?? "", time: "" }]);
    requestAnimationFrame(() => dateFields.current.get(key)?.focus());
  }
  function removeDraft(key: number) {
    const next = drafts.filter(draft => draft.key !== key);
    setDrafts(next);
    requestAnimationFrame(() => dateFields.current.get(next[0]?.key)?.focus());
  }
  function updateDraft(key: number, field: "date" | "time", value: string) {
    setDrafts(current => current.map(draft => draft.key === key ? { ...draft, [field]: value } : draft));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const proposals = drafts.map(draft => ({ start: `${String(form.get(`date-${draft.key}`) ?? "")}T${String(form.get(`time-${draft.key}`) ?? "")}` }));
    if (!proposals.length || proposals.some(slot => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot.start))) { setError("都合のよい日付と開始時刻を入力してください。"); return; }
    if (new Set(proposals.map(slot => slot.start)).size !== proposals.length) { setError("同じ候補日時が重複しています。"); return; }
    if (dates.length && proposals.some(slot => !dates.includes(slot.start.slice(0, 10)))) { setError("営業から指定された日付を選択してください。"); return; }
    setError("");
    await onSave(`/api/workflow/requests/${encodeURIComponent(request.id)}/respond`, { proposals });
  }

  return <form className="dh-engineer-response" onSubmit={submit}>
    <fieldset disabled={pending} aria-describedby="availability-response-note">
      <legend>都合のよい日時を回答</legend>
      <p id="availability-response-note" className="dh-engineer-small">{dates.length ? `営業から指定された日付：${dates.map(requestedDateLabel).join("、")}。この中で参加できる開始時刻を入力してください。` : "営業から日付・時刻の指定はありません。参加できる日付と開始時刻を入力してください。"}複数の候補を送信できます。日時確定前は回答を変更できます。時刻は日本時間です。</p>
      <div className="dh-engineer-proposals">{drafts.map((draft, index) => <div className="dh-engineer-proposal" key={draft.key}>
        <p>候補 {index + 1}</p>
        <div className="dh-engineer-proposal-fields">
          <label>日付{dates.length ? <select ref={element => { if (element) dateFields.current.set(draft.key, element); else dateFields.current.delete(draft.key); }} name={`date-${draft.key}`} required value={draft.date} aria-label={`候補${index + 1}の日付`} onChange={e => updateDraft(draft.key, "date", e.currentTarget.value)}>{dates.map(date => <option key={date} value={date}>{requestedDateLabel(date)}</option>)}</select> : <input ref={element => { if (element) dateFields.current.set(draft.key, element); else dateFields.current.delete(draft.key); }} type="date" name={`date-${draft.key}`} required value={draft.date} aria-label={`候補${index + 1}の日付`} onInput={e => updateDraft(draft.key, "date", e.currentTarget.value)} onChange={e => updateDraft(draft.key, "date", e.currentTarget.value)} />}</label>
          <label>開始時刻<input type="time" name={`time-${draft.key}`} required value={draft.time} aria-label={`候補${index + 1}の開始時刻`} onInput={e => updateDraft(draft.key, "time", e.currentTarget.value)} onChange={e => updateDraft(draft.key, "time", e.currentTarget.value)} /></label>
        </div>
        <button type="button" className="dh-engineer-proposal-remove" aria-label={`候補${index + 1}を削除`} disabled={drafts.length === 1} onClick={() => removeDraft(draft.key)}><Icon name="x" />削除</button>
      </div>)}</div>
      <button type="button" className="dh-engineer-secondary" onClick={addDraft}><Icon name="plus" />候補日時を追加</button>
    </fieldset>
    {error && <p className="dh-engineer-error" role="alert">{error}</p>}
    <button type="submit" className="dh-engineer-primary" disabled={pending}>{pending ? "回答を保存中…" : request.status === "responded" ? "候補日時を更新する" : "この日時で回答する"}<Icon name="arrow" /></button>
  </form>;
}

function RequestResponse({ request, pending, onSave }: ResponseProps) {
  const [selected, setSelected] = useState<string[]>(request.availableSlotIds);
  const [error, setError] = useState("");
  const confirmed = request.status === "confirmed";
  if (request.scheduleMode === "availability" && !confirmed) return <AvailabilityResponse request={request} pending={pending} onSave={onSave} />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slotIds = new FormData(event.currentTarget).getAll("slots").map(String);
    if (!slotIds.length) { setError("参加できる候補日時を1件以上選択してください。"); return; }
    setError("");
    await onSave(`/api/workflow/requests/${encodeURIComponent(request.id)}/respond`, { slotIds });
  }
  return <form className="dh-engineer-response" onSubmit={submit}>
    <fieldset disabled={pending || confirmed}><legend>{confirmed ? "確定した日時" : "参加できる候補日時"}</legend><p className="dh-engineer-small">{confirmed ? "営業が面談日時を確定しました。予定から面談URLを確認できます。" : "参加できる日時をすべて選択してください。確定前であれば回答を変更できます。"}</p>
      <div className="dh-engineer-slots">{request.candidates.map(slot => <label className={`dh-engineer-slot${request.confirmedSlotId === slot.id ? " is-confirmed" : ""}`} key={slot.id}><input type="checkbox" name="slots" value={slot.id} checked={confirmed ? request.confirmedSlotId === slot.id : selected.includes(slot.id)} onChange={event => setSelected(current => event.target.checked ? [...current, slot.id] : current.filter(id => id !== slot.id))} /><span>{slotLabel(slot.start, slot.end)}{request.confirmedSlotId === slot.id && <strong>確定</strong>}</span></label>)}</div>
    </fieldset>
    {error && <p className="dh-engineer-error" role="alert">{error}</p>}
    {!confirmed && <button type="submit" className="dh-engineer-primary" disabled={pending}>{pending ? "回答を保存中…" : request.status === "responded" ? "回答を更新する" : "選択した日時で回答する"}<Icon name="arrow" /></button>}
  </form>;
}

function requestSummary(request: InterviewRequest) {
  if (request.status === "confirmed") return "面談日時が確定しました";
  if (request.scheduleMode === "availability") return request.status === "requested" ? "都合のよい日時を回答してください" : `${request.availableSlotIds.length}件の候補日時を回答済み`;
  return `${request.candidates.length}件の候補日時${request.status === "responded" ? `・${request.availableSlotIds.length}件を回答済み` : ""}`;
}

function FeedbackForm({ event, pending, onSave }: { event: ScheduleEvent; pending: boolean; onSave: (path: string, payload: object) => Promise<boolean> }) {
  const [values, setValues] = useState<FeedbackValues>({ duties: "", process: "", remote: "", impression: "", questions: [""] });
  const [error, setError] = useState("");
  const questionRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const addQuestionRef = useRef<HTMLButtonElement>(null);
  const field = (name: "duties" | "process" | "remote" | "impression") => ({ name, value: values[name], onChange: (e: { target: { value: string } }) => setValues(current => ({ ...current, [name]: e.target.value })) });
  function addQuestion() {
    const index = values.questions.length;
    setValues(current => ({ ...current, questions: [...current.questions, ""] }));
    requestAnimationFrame(() => questionRefs.current[index]?.focus());
  }
  function removeQuestion(index: number) {
    setValues(current => ({ ...current, questions: current.questions.filter((_, i) => i !== index) }));
    requestAnimationFrame(() => (questionRefs.current[Math.max(0, index - 1)] ?? addQuestionRef.current)?.focus());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload = { duties: String(form.get("duties") ?? "").trim(), process: String(form.get("process") ?? "").trim(), remote: String(form.get("remote") ?? "").trim(), impression: String(form.get("impression") ?? "").trim(), questions: form.getAll("questions").map(value => String(value).trim()).filter(Boolean) };
    if (!payload.duties || !payload.process || !payload.remote || !payload.impression) { setError("業務内容・作業工程・リモート頻度・感想を入力してください。"); return; }
    setError("");
    await onSave(`/api/workflow/events/${encodeURIComponent(event.key)}/feedback`, payload);
  }
  return <form className="dh-engineer-feedback-form" onSubmit={submit}><fieldset disabled={pending}>
    <legend className="dh-engineer-sr-only">面談の所感と質問</legend>
    <label>業務内容<span className="dh-engineer-required" aria-hidden="true">必須</span><textarea {...field("duties")} rows={3} required placeholder="面談で説明された業務内容を記入してください" /></label>
    <label>作業工程<span className="dh-engineer-required" aria-hidden="true">必須</span><input {...field("process")} required placeholder="例：基本設計〜結合テスト" /></label>
    <label>リモート頻度<span className="dh-engineer-required" aria-hidden="true">必須</span><input {...field("remote")} required placeholder="例：週3日リモート、週2日出社" /></label>
    <label>感想<span className="dh-engineer-required" aria-hidden="true">必須</span><textarea {...field("impression")} rows={3} required placeholder="面談の雰囲気や気になったことを記入してください" /></label>
    <div className="dh-engineer-question-editor"><h3>聞かれた質問</h3><p className="dh-engineer-small">1問ずつ記録してください。必要なだけ追加できます。質問がなかった場合は空欄のまま提出できます。</p>{values.questions.map((text, index) => <div className="dh-engineer-question-input" key={index}><label htmlFor={`dh-question-${index}`}>質問 {index + 1}</label><textarea id={`dh-question-${index}`} name="questions" rows={2} ref={element => { questionRefs.current[index] = element; }} value={text} onChange={e => setValues(current => ({ ...current, questions: current.questions.map((question, i) => i === index ? e.target.value : question) }))} placeholder="例：トランザクション管理で工夫した点は？" /><button type="button" className="dh-engineer-remove" aria-label={`質問${index + 1}を削除`} onClick={() => removeQuestion(index)}><Icon name="x" />削除</button></div>)}<button ref={addQuestionRef} type="button" className="dh-engineer-secondary" onClick={addQuestion}><Icon name="plus" />質問を追加</button></div>
  </fieldset>{error && <p role="alert" className="dh-engineer-error">{error}</p>}<p className="dh-engineer-small">提出した内容は担当営業と共有されます。質問は同じ案件の面談準備に活用されます。</p><button type="submit" className="dh-engineer-primary" disabled={pending}>{pending ? "所感を提出中…" : "所感・質問を提出する"}<Icon name="arrow" /></button><p className="dh-engineer-demo-note">デモでは操作確認のため、面談日前でも所感を提出できます。</p></form>;
}

function SubmittedFeedback({ feedback }: { feedback: InterviewFeedback }) {
  return <div className="dh-engineer-submitted"><p className="dh-engineer-submitted-label"><Icon name="check" />提出済み<span>{dateTimeLabel(feedback.submittedAt)}</span></p><Facts rows={[["業務内容", feedback.duties], ["作業工程", feedback.process], ["リモート頻度", feedback.remote], ["感想", feedback.impression]]} /><h3>記録した質問 <span>{feedback.questions.length}件</span></h3>{feedback.questions.length ? <ol>{feedback.questions.map((question, index) => <li key={index}>{question}</li>)}</ol> : <p className="dh-engineer-small">聞かれた質問の登録はありません。</p>}<p className="dh-engineer-small">担当営業に共有済みです。</p></div>;
}

export default function EngineerDashboard({ user }: { user: DemoUser }) {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [view, setView] = useState<View>("schedule");
  const [kind, setKind] = useState<Kind>("all");
  const [selectedEvent, setSelectedEvent] = useState("");
  const [selectedInProgressEvent, setSelectedInProgressEvent] = useState("");
  const [referenceEventId, setReferenceEventId] = useState<string | null>(null);
  const [referenceOrigin, setReferenceOrigin] = useState<ReferenceOrigin | null>(null);
  const [selectedRequest, setSelectedRequest] = useState("");
  const [selectedFeedback, setSelectedFeedback] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<NotificationPreview | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const deepLinkApplied = useRef(false);
  const fetchSequence = useRef(0);
  const mutationRunning = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; fetchSequence.current++; };
  }, []);

  const fetchDashboard = useCallback(async (signal?: AbortSignal) => {
    if (!active.current) return null;
    const sequence = ++fetchSequence.current;
    try {
    const response = await fetch("/api/dashboard", { cache: "no-store", signal });
    if (!active.current || sequence !== fetchSequence.current) return null;
    if (response.status === 401) { router.replace("/login"); throw new Error("ログインの有効期限が切れました。"); }
    const body = await response.json();
    if (!active.current || sequence !== fetchSequence.current) return null;
    if (!response.ok) throw new Error(body.error || "データを取得できませんでした。もう一度お試しください。");
    if (body.currentUser && (body.currentUser.role !== "student" || body.currentUser.id !== user.id)) {
      setData(null);
      window.location.replace(body.currentUser.role === "sales" ? "/sales" : body.currentUser.role === "leader" ? "/leader" : "/engineer");
      throw new Error("ログインユーザーが切り替わりました。ホームを開き直しています。");
    }
    return body as DashboardData;
    } catch (reason) { if (sequence !== fetchSequence.current) return null; throw reason; }
  }, [router, user.id]);

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(controller.signal).then(body => {
      if (!body) return;
      setData(body);
      setError("");
      if (!deepLinkApplied.current) {
        const params = new URLSearchParams(window.location.search);
        const requestId = params.get("request");
        const eventId = params.get("event");
        if (requestId && body.requests.some(request => request.id === requestId)) { setSelectedRequest(requestId); setView("requests"); focusDetail(); }
        else if (eventId) { const linked = body.events.find(event => event.key === eventId); if (linked) openEvent(linked); }
        deepLinkApplied.current = true;
      }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "データを取得できませんでした。"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchDashboard]);

  useEffect(() => {
    const onFocus = () => {
      if (mutationRunning.current) return;
      fetchDashboard().then(body => { if (body) { setData(body); setError(""); } }).catch(reason => setError(reason instanceof Error ? reason.message : "最新の情報を取得できませんでした。"));
    };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [fetchDashboard]);

  useEffect(() => {
    if (error) { errorRef.current?.scrollIntoView({ block: "nearest" }); errorRef.current?.focus({ preventScroll: true }); }
  }, [error]);

  async function reload() {
    if (mutationRunning.current) return;
    setLoading(true); setError("");
    try { const updated = await fetchDashboard(); if (updated) { setData(updated); setError(""); } } catch (reason) { setError(reason instanceof Error ? reason.message : "データを取得できませんでした。"); } finally { setLoading(false); }
  }

  async function save(path: string, payload: object) {
    if (mutationRunning.current) return false;
    mutationRunning.current = true;
    setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as MutationResult & { error?: string };
      if (response.status === 401) { router.replace("/login"); throw new Error("ログインし直してください。"); }
      if (!response.ok) throw new Error(result.error || "保存できませんでした。入力内容を確認し、もう一度お試しください。");
      setNotice(/\/events\/[^/]+\/feedback$/.test(path) ? "所感を提出しました。営業の結果確認待ちです。" : result.message || "保存しました。");
      try { const updated = await fetchDashboard(); if (updated) { setData(updated); setError(""); } } catch { setError("保存は完了しましたが、最新の表示を取得できませんでした。更新ボタンを押してください。"); }
      if (result.preview) setPreview(result.preview);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存できませんでした。");
      return false;
    } finally { mutationRunning.current = false; if (active.current) setPending(false); }
  }

  async function acknowledge(item: ScheduleEvent) {
    if (mutationRunning.current) return;
    mutationRunning.current = true;
    setPending(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/workflow/events/${encodeURIComponent(item.key)}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json() as MutationResult & { error?: string };
      if (response.status === 401) { router.replace("/login"); throw new Error("ログインし直してください。"); }
      if (!response.ok) throw new Error(result.error || "確認を保存できませんでした。もう一度お試しください。");
      const updated = await fetchDashboard();
      if (!updated || !updated.events.some(event => event.key === item.key && event.engineerConfirmedAt)) throw new Error("確認結果の表示を取得できませんでした。更新ボタンで最新の状態を確認してください。");
      const keepReference = !item.entry && referenceEventId === item.key && Boolean(referenceOrigin);
      setData(updated); setError("");
      if (!keepReference) { setReferenceEventId(null); setReferenceOrigin(null); }
      setNotice(item.entry ? "初回入場の完了を確認しました。入場中へ移動しました。" : "面談結果を確認しました。予定から外しました。");
      if (item.entry) { setSelectedInProgressEvent(item.key); setView("inProgress"); focusDetail(); }
      else if (keepReference) focusDetail();
      else { setSelectedEvent(""); requestAnimationFrame(backToList); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "確認を保存できませんでした。");
    } finally { mutationRunning.current = false; if (active.current) setPending(false); }
  }

  const events = [...(data?.events ?? [])].sort((a, b) => a.stamp - b.stamp || a.time.localeCompare(b.time));
  const requests = [...(data?.requests ?? [])].sort((a, b) => Number(b.status === "requested") - Number(a.status === "requested"));
  const questions = data?.questions ?? [];
  const feedbacks = data?.feedbacks ?? [];
  const notifications = data?.notifications ?? [];
  const scheduledEvents = events.filter(item => !item.engineerConfirmedAt);
  const inProgressEntries = events.filter(item => item.entry && item.engineerConfirmedAt);
  const filteredEvents = view === "inProgress" ? inProgressEntries : scheduledEvents.filter(event => kind === "all" || event.type === kind);
  const referenceEvent = view === "schedule" && referenceEventId ? events.find(item => item.key === referenceEventId && !item.entry && (item.engineerConfirmedAt || referenceOrigin)) : undefined;
  const event = referenceEvent ?? filteredEvents.find(item => item.key === (view === "inProgress" ? selectedInProgressEvent : selectedEvent)) ?? filteredEvents.find(item => item.stamp >= Date.UTC(2026, 10, 5)) ?? filteredEvents[0];
  const originalInterview = event?.entry ? sourceInterview(event, events) : undefined;
  const request = requests.find(item => item.id === selectedRequest) ?? requests[0];
  const meetings = events.filter(item => !item.entry);
  const orderedFeedbackMeetings = [...meetings].sort((a, b) => Number(feedbacks.some(feedback => feedback.eventId === a.key)) - Number(feedbacks.some(feedback => feedback.eventId === b.key)));
  const feedbackEvent = orderedFeedbackMeetings.find(item => item.key === selectedFeedback) ?? orderedFeedbackMeetings[0];
  const submittedFeedback = feedbacks.find(item => item.eventId === feedbackEvent?.key);
  const pendingRequestCount = requests.filter(item => item.status === "requested").length;
  const pendingFeedbackCount = meetings.filter(item => !feedbacks.some(feedback => feedback.eventId === item.key)).length;
  const awaitingSales = (item: ScheduleEvent) => !item.entry && item.result === "pending" && feedbacks.some(feedback => feedback.eventId === item.key);

  function focusDetail() {
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 800px)").matches) {
        detailRef.current?.scrollIntoView({ block: "start" });
        detailRef.current?.focus({ preventScroll: true });
      }
    });
  }
  function backToList() { listRef.current?.scrollIntoView({ block: "start" }); (listRef.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]") ?? headingRef.current)?.focus({ preventScroll: true }); }
  function showFeedback(eventId: string) {
    if (view === "inProgress" && event?.entry) setSelectedInProgressEvent(event.key);
    setSelectedFeedback(eventId); setView("feedback"); focusDetail();
  }
  function openEvent(item: ScheduleEvent, origin?: ReferenceOrigin) {
    setKind("all");
    if (item.entry && item.engineerConfirmedAt) {
      setSelectedInProgressEvent(item.key); setReferenceEventId(null); setReferenceOrigin(null); setView("inProgress");
    } else if (!item.entry && (item.engineerConfirmedAt || origin)) {
      setReferenceOrigin(origin ?? { view: "schedule", eventId: selectedEvent });
      setReferenceEventId(item.key); setView("schedule");
    } else {
      setSelectedEvent(item.key); setReferenceEventId(null); setReferenceOrigin(null); setView("schedule");
    }
    focusDetail();
  }
  function showOriginalInterview(interview: ScheduleEvent) {
    if (view === "inProgress" && event?.entry) setSelectedInProgressEvent(event.key);
    openEvent(interview, { view: view === "inProgress" ? "inProgress" : "schedule", eventId: event?.key ?? selectedEvent });
  }
  function closeReference() {
    setReferenceEventId(null); setReferenceOrigin(null);
    if (referenceOrigin?.view === "inProgress") {
      setSelectedInProgressEvent(referenceOrigin.eventId); setView("inProgress"); focusDetail();
    } else {
      setSelectedEvent(referenceOrigin?.eventId ?? ""); setView("schedule"); requestAnimationFrame(backToList);
    }
  }
  function originalInterviewDetails() {
    if (!originalInterview) return null;
    const submitted = feedbacks.some(feedback => feedback.eventId === originalInterview.key);
    return <section className="dh-engineer-section dh-engineer-interview-history"><h3>元の面談</h3><Facts rows={[
      ["面談日時", <>{dateLabel(originalInterview.stamp)}<br /><strong>{originalInterview.time}{originalInterview.end ? ` – ${originalInterview.end}` : ""}</strong></>],
      ["面談種別", originalInterview.route],
      ["実施形式", originalInterview.format],
      ["面談URL", originalInterview.url && /^https?:\/\//i.test(originalInterview.url) ? <a href={originalInterview.url} target="_blank" rel="noreferrer">{originalInterview.url}<span className="dh-engineer-link-caption">別タブで開く <Icon name="right" /></span></a> : "未登録"],
    ]} /><div className="dh-engineer-history-actions"><button type="button" className="dh-engineer-secondary" onClick={() => showOriginalInterview(originalInterview)}>元の面談を見る<Icon name="arrow" /></button><button type="button" className="dh-engineer-primary" onClick={() => showFeedback(originalInterview.key)}>{submitted ? "提出した所感を見る" : "所感・質問を入力する"}<Icon name="arrow" /></button></div></section>;
  }
  const back = <button type="button" className="dh-engineer-back" onClick={referenceEvent ? closeReference : backToList}><Icon name="left" />一覧へ戻る</button>;
  function renderEventDetails() {
    if (!event) return <Empty title={view === "inProgress" ? "入場中の案件はありません" : "予定を選択してください"} />;
    const reference = Boolean(referenceEvent);
    const entered = event.entry && Boolean(event.engineerConfirmedAt);
    const feedback = feedbacks.find(item => item.eventId === event.key);
    const resultLabel = event.result === "passed" ? "合格" : event.result === "rejected" ? "不合格" : "未登録";
    return <>
      {reference && <div className="dh-engineer-reference-note"><span>{event.engineerConfirmedAt ? "確認済みの面談の記録です。予定には含まれません。" : "初回入場に関連する面談の記録です。"}</span><button type="button" onClick={closeReference}>{referenceOrigin?.view === "inProgress" ? "入場中に戻る" : "予定一覧に戻る"}</button></div>}
      <div className={`dh-engineer-detail-head${event.entry ? " is-entry" : ""}`}>
        <p><Icon name="folder" />{reference ? "面談の記録" : entered ? "入場中の案件" : "案件詳細"}<span>/ {event.key}</span></p><h2>{event.project}</h2>
        <span className={`dh-engineer-badge ${event.entry ? "is-entry" : awaitingSales(event) ? "is-waiting is-feedback-waiting" : ""}`}>{event.entry ? entered ? "入場中" : "初回入場　確定" : `${event.route}　${reference && event.engineerConfirmedAt ? "確認済み" : awaitingSales(event) ? "所感提出済み・営業確認待ち" : event.result === "pending" ? "確定" : resultLabel}`}</span>
      </div>
      <section className="dh-engineer-section"><h3>{event.entry ? entered ? "初回入場の記録" : "初回入場の予定" : reference ? "面談時の情報" : "面談の予定"}</h3><Facts rows={[
        [event.entry ? "集合時刻" : "日時", <>{dateLabel(event.stamp)}<br /><strong>{event.time}{event.end ? ` – ${event.end}` : event.entry ? " 集合" : ""}</strong></>],
        [event.entry ? "集合場所" : "実施形式", event.format], ["参画者", event.participantName || "未登録"], ["参画者(ひらがな)", event.participantNameKana || "未登録"], ["担当営業", "青木 美咲"],
        ...(!event.entry ? [["面談URL", event.url && /^https?:\/\//i.test(event.url) ? <a href={event.url} target="_blank" rel="noreferrer">{event.url}<span className="dh-engineer-link-caption">別タブで開く <Icon name="right" /></span></a> : "未登録"] as [string, ReactNode]] : []),
      ]} /><button type="button" className="dh-engineer-secondary" onClick={() => setPreview(calendarPreview(event))}><Icon name="calendar" />カレンダー登録内容を確認</button></section>
      {!event.entry && event.result !== "pending" && <section className={`dh-engineer-section dh-engineer-result ${event.result === "rejected" ? "is-rejected" : "is-passed"}`}><h3>面談結果</h3><p className="dh-engineer-result-label"><Icon name={event.result === "passed" ? "check" : "x"} />{resultLabel}</p>{event.engineerConfirmedAt ? <p className="dh-engineer-small">確認済み：{dateTimeLabel(event.engineerConfirmedAt)}</p> : <><p className="dh-engineer-body">営業から登録された面談結果です。確認すると、この面談は予定から外れます。</p><button type="button" className="dh-engineer-primary" disabled={pending} onClick={() => acknowledge(event)}>{pending ? "確認しています…" : "確認"}<Icon name="check" /></button></>}</section>}
      {event.entry && !entered && <section className="dh-engineer-section dh-engineer-entry-confirm"><h3>初回入場の完了確認</h3><p className="dh-engineer-body">初回入場が完了したら確認してください。確認すると入場中へ移動します。</p><button type="button" className="dh-engineer-primary" disabled={pending} onClick={() => acknowledge(event)}>{pending ? "確認しています…" : "確認"}<Icon name="check" /></button></section>}
      {entered && <section className="dh-engineer-section dh-engineer-entry-confirm"><h3>入場状況</h3><p className="dh-engineer-entry-state"><Icon name="check" />入場中</p><p className="dh-engineer-small">初回入場の完了を確認済み：{dateTimeLabel(event.engineerConfirmedAt!)}</p></section>}
      {event.entry && <section className="dh-engineer-section"><h3>当日の案内</h3><p className="dh-engineer-body">{event.guidance || "案内はまだ登録されていません。"}</p></section>}
      <section className="dh-engineer-section"><h3>案件概要</h3><p className="dh-engineer-body">{event.notes || "案件概要はまだ登録されていません。"}</p></section>
      <AttachmentSection request={requests.find(item => item.id === event.requestId)} />
      {originalInterviewDetails()}
      <section className="dh-engineer-section"><h3>この案件の過去質問<span className="question-count">{questions.filter(question => question.project === event.projectId).length}</span></h3>{questions.filter(question => question.project === event.projectId).map((question, index) => <details className="query" key={question.key}><summary><span className="q-no">Q{index + 1}</span><strong>{question.title}</strong><Icon name="chevright" /></summary><p>{question.context || "この案件の面談で聞かれた質問です。"}</p></details>)}{!questions.some(question => question.project === event.projectId) && <p className="dh-engineer-small">登録された質問はありません。</p>}</section>
      {!event.entry && <section className="dh-engineer-section"><h3>面談の振り返り</h3><p className="dh-engineer-small">{feedback ? "所感と聞かれた質問は提出済みです。" : "登録された所感はありません。"}</p>{(feedback || !reference) && <button className="dh-engineer-primary" type="button" onClick={() => showFeedback(event.key)}>{feedback ? "提出した所感を見る" : "所感・質問を入力する"}<Icon name="arrow" /></button>}</section>}
      {back}
    </>;
  }
  function calendarPreview(item: ScheduleEvent): NotificationPreview {
    return { title: item.entry ? "初回入場予定の登録内容" : "面談予定の登録内容", lines: [ { label: "案件", value: item.project }, { label: item.entry ? "入場者" : "参加者", value: item.person }, { label: item.entry ? "集合時刻" : "日時", value: `${dateLabel(item.stamp)} ${item.time}${item.end ? ` – ${item.end}` : item.entry ? " 集合" : ""}` }, { label: item.entry ? "集合場所" : "面談URL", value: item.entry ? item.format : item.url || "未登録" }, ...(item.entry ? [{ label: "当日の案内", value: item.guidance || "記載なし" }] : []) ] };
  }

  return <>
    <a className="skip-link" href="#dh-engineer-title">本文へ移動</a>
    <header className="mast"><div className="dh-engineer-mast-inner"><a className="logo" href="/engineer" aria-label="DealHunter エンジニアホーム"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></a><nav className="topnav" aria-label="エンジニアメニュー">{([ ["schedule", "calendar", "予定", scheduledEvents.length], ["requests", "inbox", "面談依頼", pendingRequestCount], ["feedback", "pen", "所感・質問", pendingFeedbackCount], ["inProgress", "brief", "入場中", inProgressEntries.length] ] as const).map(([key, icon, label, count]) => <button type="button" key={key} className={view === key ? "active" : ""} onClick={() => { setView(key); setReferenceEventId(null); setError(""); setNotice(""); }} aria-current={view === key ? "page" : undefined}><Icon name={icon} />{label}{count > 0 && <span className="nav-count">{count}</span>}</button>)}</nav><div className="dh-engineer-account"><span className="dh-engineer-role">エンジニア</span><span className="dh-engineer-user">{user.name}</span><form action={logout}><button type="submit" className="logout-btn">ログアウト</button></form></div></div></header>
    <main className="dh-engineer-main"><div className="dh-engineer-page-head"><div className="context"><span className="context-mark" />エンジニアデスク<span className="sep">/</span>自分の案件</div><div className="dh-engineer-title-row"><div><h1 id="dh-engineer-title" ref={headingRef} tabIndex={-1}>{view === "schedule" ? referenceEvent ? "面談の記録" : "面談・入場予定" : view === "inProgress" ? "入場中" : view === "requests" ? "面談依頼" : "所感・質問"}</h1><p>{view === "schedule" ? referenceEvent ? referenceEvent.engineerConfirmedAt ? "確認済みの面談記録です。予定には含まれません。" : "初回入場に関連する面談の記録を表示しています。" : `${user.name}さんの面談と、初回入場の予定です。` : view === "inProgress" ? "入場中の案件と、これまでの面談記録を確認できます。" : view === "requests" ? "案件の概要を確認し、参加できる候補日時を回答してください。" : "面談で聞いたことを記録し、次の面談準備につなげましょう。"}</p></div><button type="button" className="dh-engineer-refresh" onClick={reload} disabled={loading || pending}>{loading ? "更新中…" : "更新"}</button></div></div>
      {error && <div ref={errorRef} tabIndex={-1} className="dh-engineer-error dh-engineer-page-message" role="alert"><span>{error}</span><button type="button" onClick={reload} disabled={loading || pending}>もう一度読み込む</button></div>}{notice && <p className="dh-engineer-success dh-engineer-page-message" role="status"><Icon name="check" />{notice}</p>}
      {!data ? <div className="dh-engineer-board dh-engineer-loading"><p role="status">{loading ? "自分の案件を読み込んでいます…" : "データを取得できませんでした。上のボタンから再度読み込んでください。"}</p></div> : <div className="dh-engineer-board">
        <section className="dh-engineer-list-panel" aria-label={view === "schedule" ? "自分の予定一覧" : view === "inProgress" ? "入場中の案件一覧" : view === "requests" ? "自分宛ての面談依頼" : "所感の提出状況"}>
          <div className="dh-engineer-list-heading">{view === "schedule" ? <div className="type-tabs" aria-label="予定の種類">{([ ["all", "すべて"], ["meet", "面談"], ["entry", "初回入場"] ] as const).map(([value, label]) => <button key={value} type="button" className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => { setKind(value); setReferenceEventId(null); const items = scheduledEvents.filter(item => value === "all" || item.type === value); if (!items.some(item => item.key === selectedEvent)) setSelectedEvent(items[0]?.key ?? ""); }}>{label}</button>)}</div> : <strong>{view === "inProgress" ? "入場中の案件" : view === "requests" ? "案件ごとの依頼" : "面談ごとの記録"}</strong>}<span>{view === "schedule" || view === "inProgress" ? filteredEvents.length : view === "requests" ? requests.length : meetings.length}件</span></div>
          <div ref={listRef} className="dh-engineer-list">
            {(view === "schedule" || view === "inProgress") && (filteredEvents.length ? filteredEvents.map(item => <button className={`dh-engineer-schedule-row${event?.key === item.key ? " selected" : ""}`} type="button" key={item.key} aria-pressed={event?.key === item.key} onClick={() => { if (view === "inProgress") setSelectedInProgressEvent(item.key); else setSelectedEvent(item.key); setReferenceEventId(null); focusDetail(); }}><span className="dh-engineer-row-date"><b>{new Date(item.stamp).getUTCMonth() + 1}/{String(new Date(item.stamp).getUTCDate()).padStart(2, "0")}</b><time>{item.time}</time></span><span className="dh-engineer-row-content"><span className={`kind mark-${item.type}`}>{item.entry ? "初回入場" : "面談"}</span><strong>{item.project}</strong><span>{item.format}<i>・</i>{item.entry ? view === "inProgress" ? "入場中" : "入場案内あり" : item.route}{awaitingSales(item) && <span className="dh-engineer-row-status">所感提出済み・営業確認待ち</span>}{!item.entry && item.result !== "pending" && <span className={`dh-engineer-row-status ${item.result === "rejected" ? "is-rejected" : "is-passed"}`}>面談結果：{item.result === "passed" ? "合格" : "不合格"}・確認待ち</span>}</span></span><Icon name="chevright" /></button>) : <Empty title={view === "inProgress" ? "入場中の案件はありません" : "表示する予定はありません"}>{view === "inProgress" ? "初回入場の完了を確認すると、ここに案件が表示されます。" : "確定した予定を表示します。確認済みの予定は一覧から外れ、入場中の案件は「入場中」タブで確認できます。"}</Empty>)}
            {view === "requests" && (requests.length ? requests.map(item => <button className={`dh-engineer-item-row${request?.id === item.id ? " selected" : ""}`} key={item.id} type="button" aria-pressed={request?.id === item.id} onClick={() => { setSelectedRequest(item.id); focusDetail(); }}><span className={`dh-engineer-badge ${item.status === "requested" ? "is-waiting" : ""}`}>{requestLabels[item.status]}</span><strong>{item.project}</strong><span>{requestSummary(item)}</span><Icon name="chevright" /></button>) : <Empty title="面談依頼はありません">新しい依頼が届くと、ここに表示されます。</Empty>)}
            {view === "feedback" && (orderedFeedbackMeetings.length ? orderedFeedbackMeetings.map(item => { const submitted = feedbacks.some(feedback => feedback.eventId === item.key); return <button className={`dh-engineer-item-row${feedbackEvent?.key === item.key ? " selected" : ""}`} key={item.key} type="button" aria-pressed={feedbackEvent?.key === item.key} onClick={() => { setSelectedFeedback(item.key); focusDetail(); }}><span className={`dh-engineer-badge ${submitted ? "is-submitted" : "is-waiting"}`}>{submitted ? "提出済み" : "所感未提出"}</span><strong>{item.project}</strong><span>{dateLabel(item.stamp)} {item.time}・{item.route}</span><Icon name="chevright" /></button>; }) : <Empty title="記録する面談はまだありません">面談が登録されると、所感や質問を入力できます。</Empty>)}
          </div>
        </section>
        <aside ref={detailRef} className="dh-engineer-detail" aria-label="選択した案件の詳細" tabIndex={-1} key={`${view}-${view === "schedule" || view === "inProgress" ? event?.key : view === "requests" ? request?.id : feedbackEvent?.key}`}>
          {(view === "schedule" || view === "inProgress") && renderEventDetails()}
          {view === "requests" && (request ? <><div className="dh-engineer-detail-head"><p><Icon name="inbox" />面談依頼 <span>/ {request.id}</span></p><h2>{request.project}</h2><span className={`dh-engineer-badge ${request.status === "requested" ? "is-waiting" : ""}`}>{requestLabels[request.status]}</span></div><section className="dh-engineer-section"><h3>面談概要</h3><p className="dh-engineer-body">{request.summary}</p><Facts rows={[["面談者", request.person], ["参画者", request.participantName || "未登録"], ["参画者(ひらがな)", request.participantNameKana || "未登録"], ["担当営業", "青木 美咲"]]} /></section><AttachmentSection request={request} showEmpty /><section className="dh-engineer-section"><RequestResponse key={`${request.id}-${request.status}-${request.availableSlotIds.join(",")}`} request={request} pending={pending} onSave={(path, payload) => { setSelectedRequest(request.id); return save(path, payload); }} />{request.status === "confirmed" && <button type="button" className="dh-engineer-primary" onClick={() => { const linked = events.find(item => item.requestId === request.id && !item.entry); if (linked) openEvent(linked); }}>確定した面談を見る<Icon name="arrow" /></button>}</section>{back}</> : <Empty title="依頼を選択してください" />)}
          {view === "feedback" && (feedbackEvent ? <><div className="dh-engineer-detail-head"><p><Icon name="pen" />面談の振り返り <span>/ {feedbackEvent.key}</span></p><h2>{feedbackEvent.project}</h2><p className="dh-engineer-feedback-date">{dateLabel(feedbackEvent.stamp)} {feedbackEvent.time}・{feedbackEvent.route}</p></div><section className="dh-engineer-section">{submittedFeedback ? <SubmittedFeedback feedback={submittedFeedback} /> : <FeedbackForm key={feedbackEvent.key} event={feedbackEvent} pending={pending} onSave={(path, payload) => { setSelectedFeedback(feedbackEvent.key); return save(path, payload); }} />}</section>{back}</> : <Empty title="面談を選択してください" />)}
        </aside>
      </div>}
      {data && <details className="dh-engineer-notifications"><summary><Icon name="inbox" />連絡・カレンダープレビュー <span>{notifications.length}件</span><Icon name="chevright" /></summary>{notifications.length ? <ul>{notifications.map(notification => <li key={notification.id}><button type="button" onClick={() => setPreview(notification)}><span>{notification.kind === "calendar" ? "カレンダー" : "Lark通知"}</span><strong>{notification.title}</strong><time>{dateTimeLabel(notification.createdAt)}</time><Icon name="chevright" /></button></li>)}</ul> : <p className="dh-engineer-small">新しい連絡が登録されると、ここから内容を確認できます。</p>}</details>}
    </main>
    <PreviewModal preview={preview} onClose={() => setPreview(null)} />
  </>;
}
