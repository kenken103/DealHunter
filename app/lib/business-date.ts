const japanDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});

// Calendar stamps represent a Japanese calendar day at UTC midnight, matching the API.
export function japanDayStamp(now: number | Date = Date.now()): number {
  const parts = japanDate.formatToParts(now);
  const part = (name: string) => Number(parts.find(item => item.type === name)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}

export function dateTimeInput(dayStamp: number, time = "09:00"): string {
  return `${new Date(dayStamp).toISOString().slice(0, 10)}T${time}`;
}

export function japanMinute(now = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export function responseDeadlineLabel(deadline?: string | null, now = Date.now()): string {
  if (!deadline) return "期限指定なし";
  const minutes = Math.ceil((Date.parse(deadline + "+09:00") - now) / 60000);
  const remaining = minutes <= 0 ? "期限超過" : minutes < 60 ? `残り${minutes}分` : `残り${Math.ceil(minutes / 60)}時間`;
  return `${deadline.replace("T", " ")}（${remaining}）`;
}
