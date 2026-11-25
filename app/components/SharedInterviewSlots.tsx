import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import "./shared-interview-slots.css";

type Draft = { date: string; start: string; end: string };
type Slot = Draft & { id: string };
type Availability = { studentId: string; fromDate: string; throughDate: string; slots: Slot[] };
const blank: Draft = { date: "", start: "", end: "" };
const startTime = (slot: Draft) => Date.parse(slot.date + "T" + slot.start + ":00+09:00");

export function SharedInterviewSlots({ studentId, name, editable = false }: {
  studentId: string; name: string; editable?: boolean;
}) {
  const path = "/api/interviewer-availability/" + encodeURIComponent(studentId);
  const [data, setData] = useState<Availability | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [editId, setEditId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    if (writing.current) return;
    const current = ++sequence.current;
    try {
      const response = await fetch(path, { cache: "no-store" });
      const result = await response.json();
      if (current !== sequence.current) return;
      if (!response.ok || result.studentId !== studentId) throw new Error(result.error || "共有枠を読み込めませんでした。");
      setData(result);
      setError("");
    } catch (err) {
      if (current !== sequence.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : "共有枠を読み込めませんでした。");
    }
  }, [path, studentId]);

  useEffect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => { sequence.current++; window.removeEventListener("focus", load); };
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const midnight = Date.parse(data.fromDate + "T00:00:00+09:00") + 86400000;
    const next = Math.min(midnight, ...data.slots.map(startTime).filter(time => time >= now));
    const timer = window.setTimeout(load, Math.max(1000, next - now + 100));
    return () => window.clearTimeout(timer);
  }, [data, load, saving]);

  function reset() { setEditId(""); setDraft(blank); }

  async function mutate(action: "add" | "update" | "remove", id?: string) {
    if (writing.current) return;
    writing.current = true;
    const current = ++sequence.current;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "remove" ? { action, id } : { action, id, ...draft }) });
      const result = await response.json();
      if (current !== sequence.current) return;
      if (!response.ok || result.studentId !== studentId) throw new Error(result.error || "共有枠を保存できませんでした。");
      setData(result);
      if (action !== "remove" || editId === id) reset();
      setNotice(action === "remove" ? "面談可能枠を取り消しました。" : "面談可能枠を共有しました。");
    } catch (err) {
      if (current === sequence.current) setError(err instanceof Error ? err.message : "共有枠を保存できませんでした。");
    } finally {
      writing.current = false;
      if (current === sequence.current) setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.end <= draft.start) { setError("終了時刻は開始時刻より後にしてください。"); return; }
    void mutate(editId ? "update" : "add", editId || undefined);
  }

  const slots = data?.slots.filter(slot => startTime(slot) >= Date.now()) ?? [];
  return <section className="shared-interview-slots">
    <h3>{editable ? "営業に共有する面談可能枠" : name + "さんの面談可能枠"}</h3>
    <p>今日を含む14日間（日本時間{data && `・${data.fromDate} ～ ${data.throughDate}`}）。案件の日程確定や予約には使われない参考情報です。</p>
    {error && <p role="alert">{error} <button type="button" onClick={load} disabled={saving}>再読み込み</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">共有枠を読み込み中…</p>}
    {data && (slots.length ? <ul>{slots.map(slot => <li key={slot.id}>
      <span>{slot.date}　{slot.start} ～ {slot.end}</span>
      {editable && <span className="shared-slot-actions">
        <button type="button" disabled={saving} onClick={() => { setDraft({ date: slot.date, start: slot.start, end: slot.end }); setEditId(slot.id); setError(""); setNotice(""); }}>変更</button>
        <button type="button" disabled={saving} onClick={() => void mutate("remove", slot.id)}>枠を取り消す</button>
      </span>}
    </li>)}</ul> : <p><strong>共有枠は未登録です。</strong> 面談の可否は本人に確認してください。</p>)}
    {editable && data && <form onSubmit={submit}><fieldset disabled={saving}>
      <legend>{editId ? "登録した枠を変更" : "面談可能枠を追加"}</legend>
      <label>日付<input type="date" required min={data.fromDate} max={data.throughDate} value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></label>
      <label>開始<input type="time" required value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></label>
      <label>終了<input type="time" required value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label>
      <button type="submit">{editId ? "変更を保存" : "枠を共有"}</button>
      {editId && <button type="button" onClick={reset}>編集をやめる</button>}
    </fieldset></form>}
  </section>;
}
