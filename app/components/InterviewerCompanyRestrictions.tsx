"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { trimEndCompany } from "../lib/company-name";
import { companyRestrictionReason, isRestricted, loadRestrictionDetails, manualCompanyRoleLabels,
  type CompanyRestrictionDetails, type CompanyRole, type ManualCompanyRole } from "../lib/interviewer-companies";
export function useCompanyRestrictions(studentId: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<CompanyRestrictionDetails & { id: string; revision: number }>();
  const [failure, setFailure] = useState<{ id: string; revision: number }>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!studentId) return;
    const controller = new AbortController();
    const signal = controller.signal;
    async function load() {
      try {
        const details = await loadRestrictionDetails(studentId, { signal });
        if (!signal.aborted) setResult({ id: studentId, revision, ...details });
      } catch { if (!signal.aborted) setFailure({ id: studentId, revision }); }
    }
    void load();
    return () => controller.abort();
  }, [studentId, revision]);

  const current = result?.id === studentId && result.revision === revision ? result : undefined;
  const failed = failure?.id === studentId && failure.revision === revision;
  async function update(companyRole: ManualCompanyRole, companyName: string, restricted: boolean) {
    if (!current || failed || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const details = await loadRestrictionDetails(studentId, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyRole, companyName, restricted }),
      });
      setResult({ ...current, ...details });
      return true;
    } catch { return false; }
    finally { savingRef.current = false; setSaving(false); }
  }
  return { current: failed ? undefined : current, failed, saving, update, retry: () => setRevision(value => value + 1) };
}

export function companyRestrictionBadge(details: CompanyRestrictionDetails | undefined, role: CompanyRole, company: string, person: string) {
  if (!person || !details) return null;
  const reason = companyRestrictionReason(details, role, company);
  return reason && <span className="interviewer-ng-badge">{person}：面談担当NG（{reason}）</span>;
}

const manualRoles = ["all", "upper", "end"] as const;

export function RestrictionEditor({ state, companyNames, onUpdated }: {
  state: ReturnType<typeof useCompanyRestrictions>;
  companyNames: string[];
  onUpdated: () => void;
}) {
  const inputId = useId();
  const [company, setCompany] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const { current, failed, saving } = state;
  if (failed) return <p role="alert">面談担当NGの最新状態を確認できませんでした。 <button type="button" className="text-link" onClick={state.retry}>再取得</button></p>;
  if (!current) return <p role="status">面談担当NGを確認中…</p>;

  const ownMark = isRestricted(current.ownRestrictions, "all", company);
  const marks = manualRoles.flatMap(role => current.restrictions[role].map(name => ({
    role, name, own: current.ownRestrictions[role].includes(name),
  })));
  async function changeMark(role: ManualCompanyRole, name: string, restricted: boolean) {
    setNotice(undefined);
    if (await state.update(role, name, restricted)) {
      setNotice({ message: restricted ? `${name}をNGに登録しました。` : `${name}の自分のNG登録を解除しました。` });
      onUpdated();
    } else {
      setNotice({ message: "NG登録を更新できませんでした。もう一度お試しください。", error: true });
    }
  }
  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = trimEndCompany(company);
    if (name && !ownMark) void changeMark("all", name, true);
  }

  return <>
    <form className="ng-manual-form" onSubmit={register}>
      <label htmlFor={inputId}>会社名
        <input id={inputId} type="text" value={company} maxLength={200} required disabled={saving} onChange={event => {
          setCompany(event.target.value);
          setNotice(undefined);
        }} />
      </label>
      {companyNames.length > 0 && <label>登録済みの会社から選ぶ（任意）
        <select disabled={saving} value={companyNames.includes(company) ? company : ""} onChange={event => {
          setCompany(event.target.value);
          setNotice(undefined);
        }}>
          <option value="">会社を選択</option>
          {companyNames.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>}
      <button type="submit" className="sales-secondary" disabled={saving || !trimEndCompany(company) || ownMark}>面談担当NGに登録</button>
    </form>
    {notice ? <p role={notice.error ? "alert" : "status"}>{notice.message}</p>
      : ownMark && <p role="status">この会社はすでに自分のNGとして登録済みです。</p>}
    <h3>手動登録済みのNG</h3>
    {marks.length === 0 ? <p>登録はありません。</p> : <ul className="ng-manual-marks">
      {marks.map(({ role, name, own }) => <li key={`${role}:${name}`}>
        <span>{name} <small>{manualCompanyRoleLabels[role]}</small></span>
        {own ? <button type="button" className="text-link" disabled={saving} onClick={() => void changeMark(role, name, false)}>自分のNG登録を解除</button>
          : <small>他の営業が登録</small>}
      </li>)}
    </ul>}
  </>;
}
