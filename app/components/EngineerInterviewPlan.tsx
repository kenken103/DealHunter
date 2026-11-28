import type { ScheduleEvent } from "../types";

export type AgendaPart = "prep" | "main" | "change";
export type AgendaItem = { event: ScheduleEvent; part: AgendaPart; at: string };
export const isWithdrawn = (e: ScheduleEvent) => e.scheduleState === "postponed" || e.scheduleState === "cancelled";
export const stateLabel = (e: ScheduleEvent) => e.scheduleState === "cancelled" ? e.entry ? "初回入場中止" : "面談中止" : "日程再調整中";
export function updatedAfterInterview(event: ScheduleEvent, archivedAt: string | null | undefined) {
  return Boolean(archivedAt && event.changes.some(change => change.revision > 1 && Date.parse(change.at) >= Date.parse(archivedAt)));
}
export function agendaItems(events: ScheduleEvent[]) {
  const rows: AgendaItem[] = [];
  for (const event of events) {
    if (isWithdrawn(event)) continue;
    if (event.prepStart && !event.entry && event.result === "pending") rows.push({ event, part: "prep", at: event.prepStart });
    rows.push({ event, part: "main", at: new Date(event.stamp).toISOString().slice(0, 10) + "T" + event.time });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.event.project.localeCompare(b.event.project));
}
function JoinUrl({ url, label, historical }: { url: string; label: string; historical: boolean }) {
  if (!url || !/^https?:\/\//i.test(url)) return <strong className="dh-session-url-pending">{historical ? "URL未登録" : "URL待ち"}</strong>;
  return <a className="dh-session-link" href={url} target="_blank" rel="noreferrer">{label}を開く <span aria-label="別タブで開く">↗</span></a>;
}
function planFacts(e: ScheduleEvent) {
  return [
    ["会議ID", e.meetingId], ["パスコード", e.passcode], ["接続手順・準備事項", e.instructions],
    ["緊急連絡先", e.emergencyContact],
  ].filter(([, value]) => Boolean(value?.trim()));
}

export function EngineerInterviewPlan({ event, part, pending, historical, archivedAt, onAcknowledge, dateTimeLabel }: {
  event: ScheduleEvent; part: AgendaPart; pending: boolean; historical: boolean; archivedAt?: string | null;
  onAcknowledge: () => void; dateTimeLabel: (date: string) => string;
}) {
  const withdrawn = isWithdrawn(event);
  const mainStart = new Date(event.stamp).toISOString().slice(0, 10) + "T" + event.time;
  const revision = event.noticeRevision;
  const facts = planFacts(event);
  const changes = event.changes ?? [];
  const sharedEvaluation = event.shareFeedback && event.clientFeedback?.trim();
  const needsRead = withdrawn || !archivedAt || updatedAfterInterview(event, archivedAt) || Boolean(sharedEvaluation);
  const label = event.scheduleState === "cancelled" ? "中止" : "再調整";
  return <section className="dh-engineer-section dh-session-plan">
    {sharedEvaluation && <><h3>営業から共有された先方評価</h3><p className="dh-engineer-body">{sharedEvaluation}</p></>}
    <h3>{withdrawn ? stateLabel(event) : historical ? "面談の日時・URL" : "参加する日時・URL"}</h3>
    {withdrawn ? <><p className="dh-engineer-body">{stateLabel(event)}のため、以前の予定は取り下げられました。</p>
      {event.changeReason && <p className="dh-session-reason">{label}の理由：{event.changeReason}</p>}</> :
      <>
        {event.prepStart && <div className={"dh-session-card" + (part === "prep" ? " is-current" : "")}>
          <h4>事前打合せ</h4><p>{dateTimeLabel(event.prepStart)}</p>
          <JoinUrl url={event.prepUrl} label="事前打合せのURL" historical={historical} />
        </div>}
        <div className={"dh-session-card" + (part === "main" ? " is-current" : "")}>
          <h4>本面談 <small>{event.route}</small></h4><p>{dateTimeLabel(mainStart)}{event.end && " 〜 " + event.end}</p>
          <JoinUrl url={event.url} label="本面談のURL" historical={historical} />
        </div>
        {facts.length > 0 && <dl className="dh-engineer-facts dh-session-facts">{facts.map(([key, value]) =>
          <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
        {event.changeReason && <p className="dh-session-reason">変更理由：{event.changeReason}</p>}
      </>}
    {changes.length > 0 && <details className="dh-session-history"><summary>案内の変更履歴（{changes.length}件）</summary><ul>
      {changes.map(change => <li key={change.revision}><time>{dateTimeLabel(change.at)}</time>{" "}
        {change.state === "cancelled" ? "中止" : change.state === "postponed" ? "再調整中" : "参加案内"}
        {change.reason && " ・ " + change.reason}
        {change.prepStart && <div>事前打合せ　{dateTimeLabel(change.prepStart)}</div>}
        {change.start && <div>本面談　{dateTimeLabel(change.start)}{change.end && " 〜 " + change.end.slice(11, 16)}</div>}
      </li>)}
    </ul></details>}
    {revision > 0 && (event.noticeReadAt || needsRead) && <div className="dh-session-read">
      {event.noticeReadAt ? <p>案内を確認済み <time>{dateTimeLabel(event.noticeReadAt)}</time></p>
        : <button type="button" disabled={pending} className="dh-engineer-primary" onClick={onAcknowledge}>
          {pending ? "保存中…" : withdrawn ? label + "の連絡を確認しました" : "最新の案内を確認しました"}
        </button>}
    </div>}
  </section>;
}
