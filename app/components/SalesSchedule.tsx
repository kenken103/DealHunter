import { useState, type FormEvent } from "react";
import type { CandidateSlot, InterviewRequest, NotificationPreview, ScheduleEvent } from "../types";
import { dateTimeInput } from "../lib/business-date";

export type ScheduleReview = { path: string; payload: unknown; preview: NotificationPreview };
type ReviewProps = { onReview: (value: ScheduleReview) => void; onError: (message: string) => void };
const minute = (value?: string | null) => value?.slice(0, 16) || "";
const readable = (value: string) => minute(value).replace("T", " ");
const field = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const available = (request: InterviewRequest) => request.candidates.filter(slot => request.availableSlotIds.includes(slot.id));
const timeOf = (event: ScheduleEvent) => dateTimeInput(event.stamp, event.time);
const updatedAt = (value: string) => {
  const time = new Date(/(?:[+-]\d{2}:?\d{2}|Z)$/.test(value) ? value : value + "+09:00");
  if (!Number.isFinite(time.getTime())) return readable(value);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time);
};

export function salesRequestState(request: InterviewRequest) {
  if (request.status === "confirmed") return "日時確定済み";
  if (request.status === "requested") return "面談者の回答待ち";
  if (request.responseKind === "unavailable") return "全候補不可・再調整待ち";
  if (request.responseKind === "alternative") return "別日時の提案あり";
  return "回答済み・日時確定待ち";
}

export function slotLabel(slot: CandidateSlot) {
  if (slot.openEnded) return `${readable(slot.start)} 以降`;
  return slot.end ? `${readable(slot.start)} 〜 ${slot.end.slice(11, 16)}` : readable(slot.start);
}

function fits(slot: CandidateSlot, start: string, end = "") {
  if (!start || minute(slot.start) > start || slot.start.slice(0, 10) !== start.slice(0, 10)) return false;
  if (end && (end <= start || end.slice(0, 10) !== start.slice(0, 10))) return false;
  if (slot.openEnded) return true;
  if (slot.end) return start < minute(slot.end) && (!end || end <= minute(slot.end));
  return minute(slot.start) === start;
}

function OutboundFields({ event }: { event?: ScheduleEvent }) {
  const restoreConnection = event?.scheduleState !== "postponed";
  return <>
    <label>本面談URL（後から登録可）<input name="url" type="url" maxLength={2048} pattern="https?://.+" defaultValue={restoreConnection ? event?.url : ""} placeholder="https://…" /></label>
    {!restoreConnection && <p className="d-note">再設定後に使うURL・会議ID・パスコードを入力してください。URLは日時確定後にも登録できます。</p>}
    <details className="sales-disclosure" open={event?.prepStart && restoreConnection ? true : undefined}>
      <summary>事前打合せ{event?.prepStart && restoreConnection ? "を編集" : "を追加"}</summary>
      <div className="sales-fields-stack">
        <label>事前打合せの開始日時<input name="prepStart" type="datetime-local" defaultValue={restoreConnection ? minute(event?.prepStart) : ""} /></label>
        <label>事前打合せURL<input name="prepUrl" type="url" maxLength={2048} pattern="https?://.+" defaultValue={restoreConnection ? event?.prepUrl : ""} placeholder="https://…" /></label>
      </div>
    </details>
    <details className="sales-disclosure">
      <summary>接続手順・当日の連絡先・準備事項</summary>
      <div className="sales-fields-stack">
        <label>本面談の会議ID<input name="meetingId" maxLength={200} defaultValue={restoreConnection ? event?.meetingId : ""} /></label>
        <label>本面談のパスコード<input name="passcode" maxLength={200} defaultValue={restoreConnection ? event?.passcode : ""} autoComplete="off" /></label>
        <label>当日の緊急連絡先<input name="emergencyContact" maxLength={2000} defaultValue={event?.emergencyContact} placeholder="担当者・連絡方法" /></label>
        <label>面談者への案内・準備事項<textarea name="instructions" maxLength={2000} defaultValue={event?.instructions} rows={3} placeholder="入室の目安、画面共有の準備など" /></label>
      </div>
    </details>
    <details className="sales-disclosure">
      <summary>先方評価・本人への共有</summary>
      <div className="sales-fields-stack">
        <label>先方からの評価<textarea name="clientFeedback" maxLength={2000} rows={3} defaultValue={event?.clientFeedback} /></label>
        <label className="sales-member-option"><input type="checkbox" name="shareFeedback" defaultChecked={event?.shareFeedback} /><span>この評価を面談者本人にも表示する</span></label>
      </div>
    </details>
  </>;
}

function readNotice(form: FormData) {
  return {
    url: field(form, "url"), prepStart: field(form, "prepStart"), prepUrl: field(form, "prepUrl"),
    instructions: field(form, "instructions"), emergencyContact: field(form, "emergencyContact"),
    meetingId: field(form, "meetingId"), passcode: field(form, "passcode"),
    clientFeedback: field(form, "clientFeedback"), shareFeedback: form.has("shareFeedback"),
  };
}

function noticeError(notice: ReturnType<typeof readNotice>, start: string) {
  if (notice.prepUrl && !notice.prepStart) return "事前打合せURLを共有する場合は、事前打合せの開始日時も入力してください。";
  if (notice.prepStart && notice.prepStart >= start) return "事前打合せの開始日時は本面談より前を指定してください。";
  return "";
}

function noticeLines(n: ReturnType<typeof readNotice>) {
  const extras = [
    ["事前打合せ", readable(n.prepStart)], ["事前打合せURL", n.prepUrl || (n.prepStart ? "後から登録" : "")],
    ["会議ID", n.meetingId], ["パスコード", n.passcode], ["緊急連絡先", n.emergencyContact],
    ["案内・準備事項", n.instructions], [n.shareFeedback ? "先方評価（本人に共有）" : "先方評価（本人には非表示）", n.clientFeedback],
  ];
  return [{ label: "本面談URL", value: n.url || "URL待ち・日時のみ確定" }, ...extras.filter(([, value]) => value).map(([label, value]) => ({ label, value }))];
}

function ChangeHistory({ event }: { event: ScheduleEvent }) {
  if (!event.changes?.length) return null;
  return <details className="sales-disclosure"><summary>案内の変更履歴（{event.changes.length}件）</summary>
    <ol className="sales-notice-history">{event.changes.map(change => <li key={change.revision}>
      <strong>{change.state === "cancelled" ? "面談中止" : change.state === "postponed" ? "延期・次回未定" : "面談案内"}</strong>
      {change.prepStart && <span>事前打合せ {readable(change.prepStart)}</span>}
      {change.start && <span>本面談 {readable(change.start)}{change.end ? ` 〜 ${change.end.slice(11, 16)}` : ""}</span>}
      {change.reason && <span>{change.reason}</span>}
      <small>更新 {updatedAt(change.at)}</small>
    </li>)}</ol>
  </details>;
}

export function NoticeForm({ event, onReview, onError }: ReviewProps & { event: ScheduleEvent }) {
  const [openedRevision] = useState(event.noticeRevision);
  const [mode, setMode] = useState<"scheduled" | "postponed" | "cancelled">("scheduled");
  const [start, setStart] = useState(event.scheduleState === "postponed" ? "" : timeOf(event));
  const [end, setEnd] = useState(event.scheduleState === "postponed" || !event.end ? "" : dateTimeInput(event.stamp, event.end));
  const scheduled = mode === "scheduled";
  const moving = start !== timeOf(event) || end !== (event.end ? dateTimeInput(event.stamp, event.end) : "");
  const reasonRequired = !scheduled || moving || event.scheduleState === "postponed";
  const completed = event.result !== "pending" || event.status !== "scheduled";
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const notice = readNotice(form), reason = field(form, "reason");
    const issue = !scheduled ? "" : noticeError(notice, start);
    if (issue) return onError(issue);
    if (scheduled && end && (end <= start || start.slice(0, 10) !== end.slice(0, 10))) return onError("終了日時は本面談と同じ日の開始後を指定してください。");
    if (reasonRequired && !reason) return onError("変更理由を入力してください。");
    const label = mode === "cancelled" ? "面談を中止" : mode === "postponed" ? "面談を延期・再調整" : "面談案内を更新";
    onError("");
    onReview({ path: `events/${encodeURIComponent(event.key)}/notice`,
      payload: { revision: event.noticeRevision, scheduleState: mode, reason, ...(scheduled ? { start, end, ...notice } : {}) },
      preview: { title: label, lines: [
        { label: "案件", value: event.project }, { label: "面談者", value: event.person },
        ...(scheduled ? [{ label: "本面談", value: readable(start) + (end ? ` 〜 ${end.slice(11)}` : "") }, ...noticeLines(notice)] : []),
        ...(reason ? [{ label: "理由", value: reason }] : []),
      ], body: scheduled ? "本人に表示する内容を変更すると、最新の案内は未確認に戻ります。" : "この予定を予定表から取り下げ、案件履歴に理由を残します。" },
    });
  }
  if (openedRevision !== event.noticeRevision) return <p className="sales-warning" role="alert">編集中に案内が更新されました。この画面を閉じ、最新の予定を開き直してください。</p>;
  return <div className="sales-fields-stack"><p className="sales-context">{event.project}<br /><strong>{event.person} · 面談 {event.round || 1}/{event.totalRounds || 1}</strong></p>
    <p className="d-note" role="status">{event.scheduleState === "postponed" ? "延期中・次の日時は未定です。" : event.scheduleState === "cancelled" ? "この面談は中止されました。" : `本人の最新案内：${event.noticeReadAt ? "確認済み" : "未確認"}`}{event.changeReason && ` 理由：${event.changeReason}`}</p>
    {event.scheduleState !== "cancelled" && !completed && <form className="d-fields" onSubmit={submit}>
      <label>営業の操作<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="scheduled">{event.scheduleState === "postponed" ? "面談日時を再設定する" : "日時・URL・案内を更新する"}</option>
        {event.scheduleState !== "postponed" && <option value="postponed">延期する（次の日時は未定）</option>}
        <option value="cancelled">面談を中止する</option>
      </select></label>
      <fieldset className="sales-fields-stack sales-inline-fields" hidden={!scheduled} disabled={!scheduled}>
        <legend>本面談</legend>
        <label>本面談の開始日時<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>本面談の終了日時（任意）<input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></label>
        <OutboundFields event={event} />
      </fieldset>
      <label>変更理由{reasonRequired ? "（必須）" : "（任意）"}<textarea name="reason" required={reasonRequired} maxLength={2000} rows={2} /></label>
      <button type="submit" className="d-button">{scheduled ? "更新内容を確認" : mode === "postponed" ? "延期の内容を確認" : "中止の内容を確認"}</button>
    </form>}
    {completed && event.scheduleState !== "cancelled" && <form className="d-fields" onSubmit={e => {
      e.preventDefault();
      const f = new FormData(e.currentTarget), clientFeedback = field(f, "clientFeedback"), shareFeedback = f.has("shareFeedback");
      const instructions = field(f, "instructions");
      onError("");
      onReview({ path: `events/${encodeURIComponent(event.key)}/notice`,
        payload: { revision: event.noticeRevision, instructions, clientFeedback, shareFeedback },
        preview: { title: "先方評価・準備事項を更新", lines: [{ label: "案件", value: event.project }, { label: "面談者", value: event.person },
          { label: "本人に表示する案内・準備事項", value: instructions || "記載なし" },
          { label: shareFeedback ? "先方評価（本人にも表示）" : "先方評価（本人には非表示）", value: clientFeedback || "記載なし" }] },
      });
    }}>
      <label>面談者への案内・次回の準備事項<textarea name="instructions" rows={3} defaultValue={event.instructions} maxLength={2000} /></label>
      <label>先方からの評価<textarea name="clientFeedback" rows={3} defaultValue={event.clientFeedback} maxLength={2000} /></label>
      <label className="sales-member-option"><input type="checkbox" name="shareFeedback" defaultChecked={event.shareFeedback} /><span>この評価を面談者本人にも表示する</span></label>
      <button type="submit" className="d-button">先方評価・準備事項の内容を確認</button>
    </form>}
    <ChangeHistory event={event} />
  </div>;
}

function AvailabilityMatrix({ requests, choices, selectedIds, toggle, start, selectTime }: {
  requests: InterviewRequest[]; choices: string[]; selectedIds: string[]; toggle: (id: string) => void;
  start: string; selectTime: (value: string) => void;
}) {
  return <fieldset className="sales-members">
    <legend>今回一緒に確定する面談者</legend>
    <div className="sales-member-options">{requests.map(r =>
      <label className="sales-member-option" key={r.id}>
        <input type="checkbox" checked={selectedIds.includes(r.id)} disabled={!available(r).length || r.status !== "responded"} onChange={() => toggle(r.id)} />
        <span>{r.person}<small>{salesRequestState(r)}</small></span>
      </label>
    )}</div>
    {choices.length > 0 && <div className="sales-matrix-scroll" role="region" aria-label="候補日時と面談者の回答" tabIndex={0}>
      <table className="sales-matrix"><caption>候補日時ごとの回答（日本時間）</caption>
        <thead><tr><th scope="col">開始日時</th>{requests.map(r => <th scope="col" key={r.id}>{r.person}</th>)}</tr></thead>
        <tbody>{choices.map(time => {
          const allFit = selectedIds.length > 0 && requests.filter(r => selectedIds.includes(r.id)).every(r => available(r).some(s => fits(s, time)));
          return <tr key={time}><th scope="row"><button type="button" aria-pressed={start === time} disabled={!allFit}
            onClick={() => selectTime(time)}>{readable(time)}</button></th>
            {requests.map(r => <td key={r.id}>{r.status === "confirmed" ? "確定済" : r.status === "requested" ? "未回答" : available(r).some(slot => fits(slot, time)) ? "可" : "不可"}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>}
  </fieldset>;
}

function ReopenRequest({ request, onReview }: ReviewProps & { request: InterviewRequest }) {
  return <details className="sales-disclosure" open={request.responseKind === "unavailable" ? true : undefined}>
    <summary>本人に別の空き日時を依頼する</summary>
    <p className="d-note">現在の回答を取り下げ、{request.person}さんに新しい候補を日付から提案してもらいます。</p>
    <button type="button" className="sales-secondary" onClick={() => onReview({
      path: `requests/${encodeURIComponent(request.id)}/reopen`, payload: { revision: request.taskRevision },
      preview: { title: "空き日時を再依頼", lines: [{ label: "案件", value: request.project }, { label: "面談者", value: request.person },
        { label: "調整方法", value: "日時を指定せず、本人に新しい候補を依頼" }] },
    })}>再依頼内容を確認</button>
  </details>;
}

export function ConfirmForm({ request, requests, onReview, onError }: ReviewProps & {
  request: InterviewRequest; requests: InterviewRequest[];
}) {
  const group = requests.filter(r => r.projectId === request.projectId && r.round === request.round);
  const choices = Array.from(new Set(group.filter(r => r.status === "responded").flatMap(r => available(r).map(s => minute(s.start))))).sort();
  const [ids, setIds] = useState<string[]>(available(request).length ? [request.id] : []);
  const [start, setStart] = useState(minute(available(request)[0]?.start));
  const [end, setEnd] = useState("");
  const selected = group.filter(r => ids.includes(r.id));
  const matching = selected.filter(r => r.status === "responded" && available(r).some(slot => fits(slot, start, end)));
  const canConfirm = selected.length > 0 && selected.length === matching.length;
  const selectTime = (time: string) => { setStart(time); setEnd(""); };
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canConfirm) return onError("選択した面談者が全員参加できる開始・終了日時を指定してください。");
    const notice = readNotice(new FormData(e.currentTarget)), issue = noticeError(notice, start);
    if (issue) return onError(issue);
    const r = selected[0], slot = available(r).find(s => fits(s, start, end));
    if (!slot) return;
    const multi = selected.length > 1;
    onError("");
    onReview({
      path: multi ? "requests/group-confirm" : `requests/${encodeURIComponent(r.id)}/confirm`,
      payload: { ...(multi ? { requestIds: selected.map(item => item.id), revisions: Object.fromEntries(selected.map(item => [item.id, item.taskRevision])) }
        : { slotId: slot.id, revision: r.taskRevision }), start, end, ...notice },
      preview: { title: multi ? `${selected.length}名の本面談を一括確定` : "本面談の予定を確定",
        lines: [{ label: "案件", value: request.project }, { label: "面談者", value: selected.map(item => item.person).join("、") },
          { label: "本面談", value: readable(start) + (end ? ` 〜 ${end.slice(11)}` : "") }, ...noticeLines(notice)] },
    });
  }
  return <div className="sales-fields-stack">
    <p className="sales-context">{request.project}<br /><strong>{request.person} · 面談 {request.round}/{request.totalRounds}</strong></p>
    <p className="d-note">{salesRequestState(request)}{request.responseNote && <><br />本人からの連絡：{request.responseNote}</>}</p>
    {request.status === "responded" && <form className="d-fields" onSubmit={submit}>
      {group.length > 1 && <AvailabilityMatrix requests={group} choices={choices} selectedIds={ids}
        toggle={id => setIds(prev => prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id])}
        start={start} selectTime={selectTime} />}
      {selected.map(r => <div className="sales-response-summary" key={r.id}>
        <strong>{r.person}の参加可能日時</strong>
        {available(r).map(s => <button type="button" key={s.id} className="sales-slot-choice" onClick={() => selectTime(minute(s.start))}>{slotLabel(s)}{s.proposed ? "（本人提案）" : ""}</button>)}
        {r.id !== request.id && r.responseNote && <p>{r.responseNote}</p>}
      </div>)}
      {selected.length > 0 && <>
        <label>本面談の開始日時<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>本面談の終了日時（任意）<input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></label>
        {!canConfirm && <p className="sales-warning" role="status">選択中の全員が参加できる日時を指定してください。</p>}
        <OutboundFields />
        <button className="d-button" type="submit" disabled={!canConfirm}>{selected.length > 1 ? `${selected.length}名の確定内容を確認` : "面談の確定内容を確認"}</button>
      </>}
    </form>}
    {request.status === "responded" && <ReopenRequest request={request} onReview={onReview} onError={onError} />}
  </div>;
}
