type VisibleEntry = { when: string; project: string };
type EntryWarning = { visibleEntries: VisibleEntry[]; hasHiddenEntries: boolean; token: string };
export type EntryReview = { person: string; when: string; warning: EntryWarning | null };

// A missing or malformed response must not turn into a conflict-free review.
export function readEntryWarning(value: unknown): EntryWarning | null {
  if (value === null) return null;
  if (value && typeof value === "object" && "visibleEntries" in value && Array.isArray(value.visibleEntries)
    && value.visibleEntries.every(item => item && typeof item.when === "string" && typeof item.project === "string")
    && "hasHiddenEntries" in value && typeof value.hasHiddenEntries === "boolean"
    && (value.hasHiddenEntries || value.visibleEntries.length > 0)
    && "token" in value && typeof value.token === "string" && value.token.length > 0) {
    return { visibleEntries: value.visibleEntries, hasHiddenEntries: value.hasHiddenEntries, token: value.token };
  }
  throw new Error("初回入場日の重複を確認できませんでした。もう一度お試しください。");
}

export function EntryDayWarning({ review, checked, disabled, onCheck }: {
  review: EntryReview; checked: boolean; disabled: boolean; onCheck: (checked: boolean) => void;
}) {
  const warning = review.warning;
  if (!warning) return null;
  return <section className="sales-warning sales-entry-warning" aria-labelledby="entry-warning-title">
    <h3 id="entry-warning-title">初回入場日が重複しています</h3>
    <p>{review.person}さんには、今回の入場予定（{review.when.replace("T", " ")}・日本時間）と同じ日に、別案件の初回入場予定があります。</p>
    {warning.visibleEntries.length > 0 && <ul aria-label="同日の初回入場予定">{warning.visibleEntries.map((item, index) =>
      <li key={index}>{item.when.replace("T", " ")}（日本時間）　{item.project}</li>
    )}</ul>}
    {warning.hasHiddenEntries && <p>同じ日に、閲覧範囲外の案件にも初回入場予定があります。</p>}
    <label><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onCheck(e.currentTarget.checked)} />重複を確認し、この日程で登録します</label>
  </section>;
}
