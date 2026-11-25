import type { ReactNode } from "react";
import { dateTimeInput } from "../lib/business-date";
import type { ScheduleEvent } from "../types";

const dayFormat = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", weekday: "short", timeZone: "UTC" });

export function meetingDate(event: ScheduleEvent) {
  return `${dayFormat.format(event.stamp)} ${event.time}${event.end ? `〜${event.end}` : ""}`;
}

function localTime(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

export function inactiveMeeting(event: ScheduleEvent) {
  return event.scheduleState === "cancelled" || event.scheduleState === "postponed";
}

export function inactiveLabel(event: ScheduleEvent) {
  return event.scheduleState === "cancelled" ? "中止" : "延期・再調整中";
}

const resultLabels = { passed: "合格", rejected: "見送り", advanced: "次回面談へ", offered: "オファー", declined: "辞退" };
export function meetingStatus(event: ScheduleEvent) {
  if (inactiveMeeting(event)) return inactiveLabel(event);
  if (event.result !== "pending") return resultLabels[event.result];
  if (event.status === "feedback-submitted") return "営業の結果確認待ち";
  const endsAt = Date.parse(`${dateTimeInput(event.stamp, event.end || event.time)}+09:00`);
  if (endsAt <= Date.now()) return "所感提出待ち";
  return event.url ? "日時確定" : "日時確定・URL待ち";
}

function LinkToMeeting({ url, title }: { url: string; title: string }) {
  return /^https?:\/\//i.test(url)
    ? <a href={url} target="_blank" rel="noopener noreferrer">{title}を開く ↗</a>
    : <>URL待ち</>;
}

export function MeetingRecord({ event }: { event: ScheduleEvent }) {
  const inactive = inactiveMeeting(event);
  const rows: [string, ReactNode][] = [];
  if (inactive) {
    rows.push(["予定", inactiveLabel(event)], ["変更前の本面談", meetingDate(event)]);
    if (event.changeReason) rows.push(["理由", event.changeReason]);
  } else {
    if (event.prepStart) rows.push(["事前打合せ", <>{localTime(event.prepStart)} · <LinkToMeeting url={event.prepUrl} title="事前打合せ" /></>]);
    rows.push(["本面談", <>{meetingDate(event)} · <LinkToMeeting url={event.url} title="本面談" /></>]);
    if (event.meetingId) rows.push(["会議ID", event.meetingId]);
    if (event.passcode) rows.push(["パスコード", event.passcode]);
    if (event.instructions) rows.push(["当日の案内・準備", event.instructions]);
    if (event.emergencyContact) rows.push(["緊急連絡先", event.emergencyContact]);
  }
  if (event.clientFeedback) rows.push([event.shareFeedback ? "先方からの評価" : "先方からの評価（営業・管理者のみ）", event.clientFeedback]);
  rows.push(["本人の案内確認", event.noticeReadAt ? "最新版を確認済み" : "最新版は未確認"]);
  return <>
    <dl className="case-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {event.changes?.length > 0 && <details className="case-notice-history"><summary>案内の変更履歴（{event.changes.length}件）</summary>
      <ol>{[...event.changes].sort((a, b) => b.revision - a.revision).map(change => <li key={change.revision}>
        <strong>{change.state === "cancelled" ? "中止" : change.state === "postponed" ? "延期" : "日時・案内の登録"}</strong>
        {change.prepStart && <span>事前打合せ {localTime(change.prepStart)}</span>}
        {change.start && <span>本面談 {localTime(change.start)}{change.end ? `〜${change.end.slice(11, 16)}` : ""}</span>}{change.reason && <span>{change.reason}</span>}
      </li>)}</ol>
    </details>}
  </>;
}
