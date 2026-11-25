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
