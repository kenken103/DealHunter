"use client";

import { useState, type ReactNode } from "react";
import { companyNameForDisplay } from "../lib/company-name";
import { companyHistoryKeys, type CompanyRole } from "../lib/interviewer-companies";
import type { DashboardData, ImportedCase, Project, ScheduleEvent } from "../types";
import { meetingStatus } from "./MeetingRecord";
import { importedCaseStage } from "./ImportedCaseRecord";

type Source = Pick<DashboardData, "projects" | "requests" | "events" | "importedCases">;
type HistoryProps = { data: Source; companies: string[]; studentIds: string[]; excludeProjectId?: string };
type HistoryRow = { project: Project; studentId: string; person: string; proposal: string; events: ScheduleEvent[]; imported?: ImportedCase };
const companyNames = (project: Project) => [project.upperCompany, project.primeCompany, project.endCompany].filter(Boolean);


function historyRows({ data, companies, studentIds, excludeProjectId }: HistoryProps) {
  const targets = new Set(companies.flatMap(companyHistoryKeys));
  const people = new Set(studentIds);
  const projects = new Map(data.projects.filter(project => project.id !== excludeProjectId &&
    companyNames(project).flatMap(companyHistoryKeys).some(key => targets.has(key))).map(project => [project.id, project]));
  const records = new Map<string, HistoryRow>();
  function get(projectId: string, studentId: string, person: string) {
    const project = projects.get(projectId);
    if (!project || !people.has(studentId)) return;
    const key = projectId + ":" + studentId;
    let row = records.get(key);
    if (!row) { row = { project, studentId, person, proposal: "", events: [] }; records.set(key, row); }
    return row;
  }
  for (const request of data.requests) {
    const row = get(request.projectId, request.studentId, request.person);
    if (row && request.createdAt && (!row.proposal || request.createdAt < row.proposal)) row.proposal = request.createdAt;
  }
  for (const event of data.events) get(event.projectId, event.studentId, event.person)?.events.push(event);
  for (const record of data.importedCases ?? []) {
    if (!record.studentId) continue;
    const row = get(record.projectId, record.studentId, record.person || "未登録");
    if (row) row.imported = record;
  }
  const value = (row: HistoryRow) => Math.max(Date.parse(row.proposal) || 0, Date.parse(row.imported?.interviewDate || "") || 0, ...row.events.map(event => event.stamp));
  return [...records.values()].sort((a, b) => value(b) - value(a) || a.project.name.localeCompare(b.project.name, "ja"));
}

type CompanyBadge = (role: CompanyRole, company: string) => ReactNode;
function Timeline({ rows, onSelect, badge }: { rows: HistoryRow[]; onSelect?: (projectId: string, studentId: string) => void; badge?: CompanyBadge }) {
  if (!rows.length) return <p className="case-muted">閲覧できる案件に、この組み合わせの提案・面談履歴はありません。</p>;
  return <ul className="company-history-rows">{rows.map(({ project, studentId, person, proposal, events, imported }) => {
    const latest = [...events].sort((a, b) => b.stamp - a.stamp || b.time.localeCompare(a.time))[0];
    const meetings = events.filter(e => !e.entry);
    let state = imported ? importedCaseStage(imported) : "面談依頼";
    if (latest?.entry) state = latest.engineerConfirmedAt ? "入場中" : "初回入場予定";
    else if (latest) state = meetingStatus(latest);
    return <li key={project.id + ":" + studentId}>
      <strong>{project.name}</strong><span>{person} · {state}</span>
      {badge && <span>
        上位会社：{companyNameForDisplay(project.upperCompany) ?? "未登録"}{badge("upper", project.upperCompany)}
        {companyNameForDisplay(project.primeCompany) && <>　元請け：{project.primeCompany}{badge("prime", project.primeCompany)}</>}
        　エンド企業：{companyNameForDisplay(project.endCompany) ?? "未入力"}{badge("end", project.endCompany)}
      </span>}
      <small>{proposal && `依頼 ${new Date(proposal).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })} · `}
        {imported && `面談日 ${imported.interviewDate || "未入力"}`}
        {imported && meetings.length > 0 && " · "}
        {meetings.length ? `面談記録 ${meetings.length}件` : !imported && "面談記録なし"}
        {latest && ` · 直近の記録 ${new Date(latest.stamp).toLocaleDateString("ja-JP", { timeZone: "UTC" })}`}</small>
      {onSelect && <button type="button" className="text-link" onClick={() => onSelect(project.id, studentId)}>案件の履歴を開く</button>}
    </li>;
  })}</ul>;
}

export default function CompanyInterviewHistory(props: HistoryProps) {
  if (!props.companies.some(name => name.trim()) || !props.studentIds.length) return null;
  const rows = historyRows(props);
  return <details className="company-history"><summary>同じ取引先への提案・面談履歴（{rows.length}件）</summary><Timeline rows={rows} /></details>;
}

export function CompanyHistorySearch({ data, onSelect, person, personName, badge }: { data: Source; onSelect: (projectId: string, studentId: string) => void; person: string; personName: string; badge: CompanyBadge }) {
  const [company, setCompany] = useState("");
  const names = new Map<string, string>();
  for (const project of data.projects) for (const value of companyNames(project)) {
    for (const name of value.split("→").map(part => part.trim()).filter(Boolean)) {
      const [key] = companyHistoryKeys(name);
      if (key && !names.has(key)) names.set(key, name);
    }
  }
  return <details className="company-history company-history-search"><summary>取引先と面談者から提案履歴を探す</summary>
    <div className="company-history-filters">
      <label>取引先（上位・元請け・エンド）<select value={company} onChange={e => setCompany(e.target.value)}>
        <option value="">取引先を選択</option>{[...names.values()].sort((a, b) => a.localeCompare(b, "ja")).map(name => <option key={name}>{name}</option>)}
      </select></label>
    </div>
    <p className="case-muted">{personName ? `対象面談者：${personName}` : "上の面談者欄から履歴を確認する人を選択してください。"}</p>
    {company && person && <Timeline rows={historyRows({ data, companies: [company], studentIds: [person] })} onSelect={onSelect} badge={badge} />}
  </details>;
}
