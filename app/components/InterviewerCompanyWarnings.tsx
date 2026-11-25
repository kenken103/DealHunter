"use client";

import { useEffect, useState } from "react";
import { trimEndCompany } from "../lib/company-name";
import { companyRestrictionReason, companyRoleLabels, loadRestrictionDetails,
  type CompanyRestrictionDetails, type CompanyRole } from "../lib/interviewer-companies";

type Student = { id: string; name: string };
export type CompanyWarning = { id: string; name: string; messages: string[] };
type CompanyNames = Record<CompanyRole, string>;

function messages(details: CompanyRestrictionDetails, companies: CompanyNames) {
  const result: string[] = [];
  for (const role of ["upper", "prime", "end"] as const) {
    const name = trimEndCompany(companies[role]);
    const reason = companyRestrictionReason(details, role, name);
    if (reason) result.push(`${companyRoleLabels[role]}：NG（${name}・${reason}）`);
  }
  return result;
}

const unavailable = "会社別のNGを確認できませんでした。依頼内容を再度確認すると再取得します。";
export async function checkInterviewerCompanies(students: Student[], companies: CompanyNames): Promise<CompanyWarning[]> {
  return Promise.all(students.map(async student => {
    try {
      return { ...student, messages: messages(await loadRestrictionDetails(student.id), companies) };
    } catch {
      return { ...student, messages: [unavailable] };
    }
  }));
}

export function CompanyWarningList({ warnings }: { warnings: CompanyWarning[] }) {
  const visible = warnings.filter(item => item.messages.length);
  if (!visible.length) return null;
  return <aside className="d-question" aria-label="面談担当者の会社別警告">
    <strong>面談担当者の会社別警告</strong>
    <ul>{visible.map(item => <li key={item.id}>{item.name} — {item.messages.join(" ／ ")}</li>)}</ul>
    <p>担当者を変更するか、このまま依頼するかを営業が判断してください。</p>
  </aside>;
}

export function InterviewerCompanyWarning({ student, companies }: { student: Student; companies: CompanyNames }) {
  const [restrictions, setRestrictions] = useState<CompanyRestrictionDetails | null | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    loadRestrictionDetails(student.id, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setRestrictions(result); })
      .catch(() => { if (!controller.signal.aborted) setRestrictions(null); });
    return () => controller.abort();
  }, [student.id]);
  if (restrictions === undefined) return <p className="sales-field-note">{student.name}の会社別NGを確認中…</p>;
  return <CompanyWarningList warnings={[{ ...student, messages: restrictions ? messages(restrictions, companies) : [unavailable] }]} />;
}
