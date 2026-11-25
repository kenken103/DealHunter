import { useEffect, useRef, useState, type FormEvent } from "react";
import { japanDayStamp } from "../lib/business-date";
import "./shared-interview-slots.css";

type Results = {
  matches: string[];
  counts: { busy: number; unavailable: number; booked: number; unknownEnd: number };
};

type Props = {
  people: { id: string; name: string }[];
  selected: string[];
  disabled: boolean;
  onSelect: (id: string, checked: boolean) => void;
};

export function AvailableInterviewerSearch({ people, selected, disabled, onSelect }: Props) {
  const [interval, setInterval] = useState({ date: "", start: "", end: "" });
  const [result, setResult] = useState<Results | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [today, setToday] = useState(() => japanDayStamp());
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const startsAt = result ? Date.parse(interval.date + "T" + interval.start + ":00+09:00") : Infinity;
    const nextMidnight = Date.parse(new Date(today + 86400000).toISOString().slice(0, 10) + "T00:00:00+09:00");
    function refresh() {
      setToday(japanDayStamp());
      if (Date.now() >= startsAt) {
        setResult(null);
        setError("指定した開始時刻を過ぎました。日時を変更して検索してください。");
      }
    }
    const timer = window.setTimeout(refresh, Math.max(0, Math.min(startsAt, nextMidnight) - Date.now()) + 1);
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [today, interval.date, interval.start, result]);

  function edit(field: keyof typeof interval, value: string) {
    active.current?.abort();
    setInterval(current => ({ ...current, [field]: value }));
    setResult(null);
    setError("");
    setLoading(false);
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setResult(null);
    setError("");
    if (interval.end <= interval.start) {
      setError("同じ日で、開始より後の終了時刻を指定してください。");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/available-interviewers", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(interval),
        cache: "no-store", signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Larkカレンダーの空き時間を取得できませんでした。");
      if (!Array.isArray(data.matches) || !data.counts ||
        ![data.counts.busy, data.counts.unavailable, data.counts.booked, data.counts.unknownEnd].every(Number.isInteger)) {
        throw new Error("Larkカレンダーの照会結果を読み取れませんでした。");
      }
      if (!controller.signal.aborted) setResult(data);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "検索できませんでした。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const matches = result ? people.filter(person => result.matches.includes(person.id)) : [];
  return <details className="shared-interview-slots">
    <summary>日時から面談者を探す</summary>
    <p>LarkカレンダーとDealHunterの確定面談を照合します。今日から14日間の空き時間を日本時間で検索できます。</p>
    <form onSubmit={search}><fieldset disabled={disabled}><legend>希望の面談時間帯</legend>
      <label>面談日<input type="date" required min={new Date(today).toISOString().slice(0,10)}
        max={new Date(today + 13 * 86400000).toISOString().slice(0,10)} value={interval.date} onChange={e => edit("date", e.target.value)} /></label>
      <label>開始<input type="time" required value={interval.start} onChange={e => edit("start", e.target.value)} /></label>
      <label>終了<input type="time" required value={interval.end} onChange={e => edit("end", e.target.value)} /></label>
      <button disabled={loading}>{loading ? "カレンダーを確認中…" : "面談者を検索"}</button>
    </fieldset></form>
    {error && <p role="alert">{error}</p>}
    {result && <div>
      <strong role="status">指定時間に空いている面談者　{matches.length}名</strong>
      {matches.length > 0 && <fieldset className="lark-interviewer-choices" disabled={disabled}>
        <legend>依頼する面談者を選択</legend>
        {matches.map(person => <label key={person.id}>
          <input type="checkbox" checked={selected.includes(person.id)} onChange={e => onSelect(person.id, e.currentTarget.checked)} />
          <span>{person.name}</span>
        </label>)}
      </fieldset>}
      {result.counts.busy > 0 && <p>Larkカレンダーに予定あり　{result.counts.busy}名</p>}
      {result.counts.unavailable > 0 && <p>Larkカレンダーを確認できず、空き状況不明　{result.counts.unavailable}名</p>}
      {result.counts.booked > 0 && <p>DealHunterの確定面談と重複　{result.counts.booked}名</p>}
      {result.counts.unknownEnd > 0 && <p>DealHunterの面談終了時刻が未登録で要確認　{result.counts.unknownEnd}名</p>}
    </div>}
  </details>;
}
