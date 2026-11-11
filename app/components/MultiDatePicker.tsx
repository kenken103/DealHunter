"use client";

import { useId, useRef, useState } from "react";

type Props = { value: string[]; onChange: (dates: string[]) => void; disabled?: boolean };
const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
const todayInJapan = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateLabel = (date: string) => new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

export default function MultiDatePicker({ value, onChange, disabled = false }: Props) {
  const headingId = useId();
  const calendar = useRef<HTMLDivElement>(null);
  const [today] = useState(todayInJapan);
  const [month, setMonth] = useState(() => {
    const [year, number] = (value[0] || today).split("-").map(Number);
    return year * 12 + number - 1;
  });
  const year = Math.floor(month / 12), monthNumber = month % 12 + 1;
  const prefix = `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`;
  const firstDay = new Date(`${prefix}-01T00:00:00Z`);
  const nextMonth = new Date(firstDay);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCDate(0);
  const daysInMonth = nextMonth.getUTCDate();
  const selected = new Set(value);

  function toggle(date: string) {
    onChange(selected.has(date) ? value.filter(item => item !== date) : [...value, date].sort());
  }
  function focusCalendar(date?: string) {
    requestAnimationFrame(() => {
      const day = date ? calendar.current?.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`) : null;
      (day ?? calendar.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
  }

  return <div className="sales-date-picker" ref={calendar}>
    <div className="sales-date-picker-head">
      <button type="button" aria-label="前の月を表示" disabled={disabled || month <= 12} onClick={() => setMonth(current => current - 1)}>‹</button>
      <strong id={headingId} aria-live="polite">{year}年{monthNumber}月</strong>
      <button type="button" aria-label="次の月を表示" disabled={disabled || month >= 9999 * 12 + 11} onClick={() => setMonth(current => current + 1)}>›</button>
    </div>
    <div className="sales-date-picker-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
    <div className="sales-date-picker-days" role="group" aria-labelledby={headingId}>
      {Array.from({ length: firstDay.getUTCDay() }, (_, index) => <span key={`blank-${index}`} />)}
      {Array.from({ length: daysInMonth }, (_, index) => {
        const date = `${prefix}-${String(index + 1).padStart(2, "0")}`;
        return <button key={date} data-date={date} type="button" aria-label={dateLabel(date)} aria-pressed={selected.has(date)} aria-current={date === today ? "date" : undefined} disabled={disabled} onClick={() => toggle(date)}>{index + 1}</button>;
      })}
    </div>
    <div className="sales-date-selection">
      <div className="sales-date-selection-head"><strong aria-live="polite">選択した日付（{value.length}日）</strong>{value.length > 0 && <button type="button" className="text-link" disabled={disabled} onClick={() => { onChange([]); focusCalendar(); }}>すべて解除</button>}</div>
      {value.length ? <ul>{value.map(date => <li key={date}><input type="hidden" name="requestedDates" value={date} /><span>{dateLabel(date)}</span><button type="button" disabled={disabled} aria-label={`${dateLabel(date)}の指定を解除`} onClick={() => { toggle(date); focusCalendar(date); }}>×</button></li>)}</ul> : <p className="sales-unrestricted">日付の指定なし</p>}
    </div>
  </div>;
}
