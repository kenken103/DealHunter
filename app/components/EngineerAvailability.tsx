import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CandidateSlot, InterviewRequest } from "../types";

type Mode = "available" | "alternative" | "unavailable";
type Span = "exact" | "range" | "after";
type Proposal = { key: number; date: string; time: string; end: string; span: Span };
type Draft = { mode: Mode; slots: string[]; proposals: Proposal[]; note: string };
export type EngineerResponseDrafts = Map<string, Draft>;
export const responseDraftKey = (r: InterviewRequest) =>
  [r.id, r.round, r.taskRevision, r.status, r.responseKind, r.scheduleMode, ...r.requestedDates, ...r.candidates.map(slot => slot.id), ...r.availableSlotIds].join(":");

function blank(key: number, date = ""): Proposal {
  return { key, date, time: "", end: "", span: "exact" };
}
function initial(r: InterviewRequest): Draft {
  const accepted = r.candidates.filter(s => r.availableSlotIds.includes(s.id) && (r.scheduleMode === "availability" || s.proposed));
  return {
    mode: r.responseKind === "alternative" || r.responseKind === "unavailable" ? r.responseKind : "available",
    slots: r.availableSlotIds,
    note: r.responseNote || "",
    proposals: accepted.length ? accepted.map((s, key) => ({
      key, date: s.start.slice(0, 10), time: s.start.slice(11, 16), end: s.end?.slice(11, 16) || "",
      span: s.openEnded ? "after" : s.end ? "range" : "exact",
    })) : [blank(0, r.requestedDates[0])],
  };
}
type Props = {
  request: InterviewRequest; pending: boolean; drafts: EngineerResponseDrafts;
  onSave: (path: string, body: object) => Promise<boolean>;
  slotLabel: (start: string, end: string | null) => string;
};
function candidateText(slot: CandidateSlot, label: Props["slotLabel"]) {
  return label(slot.start, slot.end) + (slot.openEnded ? " 以降" : "");
}

export function EngineerAvailability({ request: r, pending, drafts, onSave, slotLabel }: Props) {
  const cacheKey = responseDraftKey(r);
  const [draft, set] = useState<Draft>(() => drafts.get(cacheKey) ?? initial(r));
  const [error, setError] = useState("");
  const dates = useRef(new Map<number, HTMLElement>());
  const next = useRef(Math.max(...draft.proposals.map(p => p.key), 0) + 1);
  useEffect(() => { drafts.set(cacheKey, draft); }, [drafts, cacheKey, draft]);
  const picking = r.scheduleMode === "candidates" && draft.mode === "available";
  const dateOptions = draft.mode === "available" ? r.requestedDates : [];

  function edit(key: number, patch: Partial<Proposal>) {
    set(d => ({ ...d, proposals: d.proposals.map(p => p.key === key ? { ...p, ...patch } : p) }));
  }
  function add() {
    const key = next.current++;
    set(d => ({ ...d, proposals: [...d.proposals, blank(key, dateOptions[0])] }));
    requestAnimationFrame(() => dates.current.get(key)?.focus());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload: { responseKind: Mode; responseNote: string; revision: number; slotIds?: string[]; proposals?: { start: string; end?: string; openEnded?: boolean }[] } = {
      responseKind: draft.mode, responseNote: draft.note.trim(), revision: r.taskRevision,
    };
    if (picking) {
      payload.slotIds = form.getAll("slots").map(String);
      if (!payload.slotIds.length) { setError("参加できる候補を選択してください。"); return; }
    } else if (draft.mode !== "unavailable") {
      const proposals = draft.proposals.map(p => {
        const date = String(form.get("date-" + p.key) || "");
        const time = String(form.get("time-" + p.key) || "");
        const start = date + "T" + time;
        if (p.span === "range") return { start, end: date + "T" + String(form.get("end-" + p.key) || "") };
        return p.span === "after" ? { start, openEnded: true } : { start };
      });
      if (proposals.some(p => p.end && p.end <= p.start)) { setError("終了時刻は開始時刻より後にしてください。"); return; }
      if (new Set(proposals.map(p => p.start)).size !== proposals.length) { setError("同じ開始日時が重複しています。"); return; }
      if (dateOptions.length && proposals.some(p => !dateOptions.includes(p.start.slice(0, 10)))) { setError("指定日以外は「別の日時を提案」で回答してください。"); return; }
      payload.proposals = proposals;
    }
    setError("");
    if (await onSave("/api/workflow/requests/" + encodeURIComponent(r.id) + "/respond", payload)) drafts.delete(cacheKey);
  }
  if (r.status === "confirmed") return null;
  const chooseMode = (mode: Mode) => { setError(""); set(d => ({ ...d, mode })); };
  const hasSuggested = r.scheduleMode === "candidates" || r.requestedDates.length > 0;
  const availableLabel = r.scheduleMode === "candidates" ? "提示された候補から選ぶ" : r.requestedDates.length ? "指定日で回答" : "参加できる日時を提案";
  return <form className="dh-engineer-response" onSubmit={submit}>
    <fieldset disabled={pending}><legend>営業への日程回答</legend>
      <div className="dh-response-modes">
        <label><input type="radio" name="answer-kind" checked={draft.mode === "available"} onChange={() => chooseMode("available")} />{availableLabel}</label>
        {hasSuggested && <label><input type="radio" name="answer-kind" checked={draft.mode === "alternative"} onChange={() => chooseMode("alternative")} />別の日時を提案</label>}
        <label><input type="radio" name="answer-kind" checked={draft.mode === "unavailable"} onChange={() => chooseMode("unavailable")} />{hasSuggested ? "全候補で参加できない" : "参加できる日程がない"}</label>
      </div>
      {picking && <div className="dh-engineer-slots">{r.candidates.filter(s => !s.proposed).map(s => <label key={s.id} className="dh-engineer-slot">
        <input type="checkbox" name="slots" value={s.id} checked={draft.slots.includes(s.id)}
          onChange={e => set(d => ({ ...d, slots: e.target.checked ? [...d.slots, s.id] : d.slots.filter(k => k !== s.id) }))} />
        <span>{candidateText(s, slotLabel)}</span>
      </label>)}</div>}
      {!picking && draft.mode !== "unavailable" && <>
        <div className="dh-engineer-proposals">{draft.proposals.map((p, i) => {
          const ref = (el: HTMLElement | null) => { if (el) dates.current.set(p.key, el); else dates.current.delete(p.key); };
          return <div key={p.key} className="dh-engineer-proposal"><p>候補 {i + 1}（日本時間）</p>
            <div className="dh-engineer-proposal-fields">
              <label>日付{dateOptions.length ? <select name={"date-" + p.key} ref={ref} value={dateOptions.includes(p.date) ? p.date : dateOptions[0]} onChange={e => edit(p.key, { date: e.target.value })}>
                {dateOptions.map(d => <option key={d} value={d}>{d}</option>)}</select> : <input ref={ref} required type="date" name={"date-" + p.key} value={p.date} onChange={e => edit(p.key, { date: e.target.value })} />}</label>
              <label>参加できる時間<select value={p.span} onChange={e => edit(p.key, { span: e.target.value as Span })}>
                <option value="exact">この時刻に開始</option><option value="range">この時間帯の中</option><option value="after">この時刻以降</option></select></label>
              <label>開始時刻<input type="time" required name={"time-" + p.key} value={p.time} onChange={e => edit(p.key, { time: e.target.value })} /></label>
              {p.span === "range" && <label>終了時刻<input type="time" required name={"end-" + p.key} value={p.end} onChange={e => edit(p.key, { end: e.target.value })} /></label>}
            </div>
            {draft.proposals.length > 1 && <button type="button" className="dh-engineer-proposal-remove" onClick={() => {
              const remain = draft.proposals.filter(other => other.key !== p.key);
              set(d => ({ ...d, proposals: remain })); requestAnimationFrame(() => dates.current.get(remain[0].key)?.focus());
            }}>候補 {i + 1} を削除</button>}
          </div>;
        })}</div><button type="button" className="dh-engineer-secondary" onClick={add}>候補日時を追加</button>
      </>}
      <label className="dh-response-note">営業への補足（任意）<textarea rows={2} maxLength={500} value={draft.note} onChange={e => set(d => ({ ...d, note: e.target.value }))} /></label>
    </fieldset>
    {error && <p className="dh-engineer-error" role="alert">{error}</p>}
    <button className="dh-engineer-primary" type="submit" disabled={pending}>{pending ? "回答を保存中…" : r.status === "responded" ? "回答を更新する" : "営業に回答する"}</button>
  </form>;
}
