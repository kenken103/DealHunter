"use client";

import { useState, type FormEvent } from "react";
import type { ScheduleEvent, ScheduleState } from "../types";
import { dateTimeInput, japanMinute } from "../lib/business-date";
import { EntryDayWarning, readEntryWarning, type EntryReview } from "./EntryDayWarning";
import "./placement-editor.css";

async function saveChange(path: string, payload: object) {
  const response = await fetch("/api/workflow/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok && data.code !== "ENTRY_DAY_CONFLICT") throw new Error(data.error || "保存できませんでした。");
  return data;
}

export function entryState(entry: ScheduleEvent) {
  if (entry.endedOn) return "参画終了";
  if (entry.scheduleState === "postponed") return "初回入場延期";
  if (entry.scheduleState === "cancelled") return "初回入場取消";
  return entry.engineerConfirmedAt ? "参画（入場済み）" : "初回入場予定";
}

export function EntryPlan({ entry, editable, onChanged }: { entry: ScheduleEvent; editable: boolean; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<ScheduleState>(entry.scheduleState);
  const [warning, setWarning] = useState<EntryReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    try {
      const fields = Object.fromEntries(form);
      const data = await saveChange("events/" + encodeURIComponent(entry.key) + "/entry-change",
        { ...fields, scheduleState: state, undoCompletion: fields.undoCompletion === "yes", revision: entry.noticeRevision, entryWarningToken: approved ? warning?.warning?.token : undefined });
      if (data.code === "ENTRY_DAY_CONFLICT") {
        setWarning({ person: entry.person, when: String(fields.when), warning: readEntryWarning(data.entryWarning) }); setApproved(false);
      } else { setWarning(null); setApproved(false); setMessage(data.message); await onChanged(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  }
  return <section className="placement-panel">
    <p>入場案内　{entry.noticeReadAt ? "本人確認済み" : "本人未確認"}</p>
    {entry.changeReason && <p>変更理由　{entry.changeReason}</p>}
    {!!entry.changes?.length && <details><summary>入場案内の変更履歴</summary><ul>{entry.changes.map(change =>
      <li key={change.revision}>{change.start.replace("T", " ")}　{change.state === "cancelled" ? "取消" : change.state === "postponed" ? "延期" : "入場予定"}　{change.meetingPlace}　{change.guidance}　{change.reason}</li>)}</ul></details>}
    {editable && !entry.engineerConfirmedAt && entry.scheduleState !== "cancelled" && <details>
      <summary>初回入場の変更・延期・取消</summary>
      <form className="d-fields" onSubmit={submit}>
        <fieldset disabled={busy} onChange={() => { setWarning(null); setApproved(false); }}>
          <label>入場予定の状態<select value={state} onChange={e => setState(e.target.value as ScheduleState)}>
            <option value="scheduled">入場予定を設定する</option><option value="postponed">延期する</option><option value="cancelled">取り消す</option>
          </select></label>
          {state === "scheduled" && <><label>集合日時（日本時間）<input type="datetime-local" name="when" required defaultValue={dateTimeInput(entry.stamp, entry.time)} /></label>
            <label>集合場所<input name="where" required maxLength={2000} defaultValue={entry.format} /></label>
            <label>当日の案内<textarea name="memo" maxLength={2000} defaultValue={entry.guidance} /></label></>}
          <label>変更理由<textarea name="reason" required maxLength={2000} /></label>
        </fieldset>
        {warning && <EntryDayWarning review={warning} checked={approved} disabled={busy} onCheck={setApproved} />}
        <button className="sales-secondary" disabled={busy || (!!warning && !approved)}>{busy ? "保存中…" : state === "cancelled" ? "入場予定を取り消して本人に表示" : "変更を本人に表示"}</button>
      </form></details>}
    {message && <p role="status">{message}</p>}
    {editable && entry.engineerConfirmedAt && !entry.endedOn && <details><summary>誤って報告した入場完了を訂正</summary>
      <form className="d-fields" onSubmit={submit}><input type="hidden" name="undoCompletion" value="yes" />
        <label>訂正理由<textarea required name="reason" maxLength={1000} /></label><button disabled={busy} className="sales-secondary">完了を取り消して本人の入場予定に戻す</button>
      </form></details>}
  </section>;
}

export function PlacementExit({ projectId, studentId, endedOn, reason, onChanged }: {
  projectId: string; studentId: string; endedOn?: string | null; reason?: string; onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    setBusy(true); setMessage("");
    try {
      const response = await saveChange("projects/" + encodeURIComponent(projectId) + "/exit",
        { ...payload, studentId, previousEnd: endedOn || "", previousReason: reason || "", resume: submitter?.value === "resume" });
      setMessage(response.message); await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  }
  return <div className="placement-panel"><details><summary>{endedOn ? "参画終了の訂正" : "参画終了を登録"}</summary>
    <form className="d-fields" onSubmit={submit}><fieldset disabled={busy}>
      <label>参画終了日<input name="endedOn" type="date" required max={japanMinute().slice(0,10)} defaultValue={endedOn || japanMinute().slice(0,10)} /></label>
      <label>終了理由（任意）<textarea name="reason" maxLength={1000} defaultValue={reason || ""} /></label>
      <button className="sales-secondary">終了日を保存</button>
      {endedOn && <button className="sales-secondary" value="resume" formNoValidate>終了を取り消して入場中に戻す</button>}
    </fieldset></form></details>{message && <p role="status">{message}</p>}</div>;
}
