"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { trimEndCompany as trimCompanyName } from "../lib/company-name";
import { loadCompanyCandidates } from "../lib/interviewer-companies";
import "./end-company-field.css";

type FieldProps = {
  value: string;
  onChange: (value: string) => void;
  addingNew: boolean;
  onAddingNewChange: (adding: boolean) => void;
  knownCompanies: string[];
};

function useCandidates<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(result => {
      if (!controller.signal.aborted) { setData(result); setState("ready"); }
    }).catch(() => {
      if (!controller.signal.aborted) setState("error");
    });
    return () => controller.abort();
  }, [load, attempt]);

  return { data, state, retry: () => { setState("loading"); setAttempt(n => n + 1); } };
}

function CandidateStatus({ state, retry, addingNew, id }: {
  state: "loading" | "ready" | "error"; retry: () => void; addingNew: boolean; id: string;
}) {
  if (state === "ready" && !addingNew) return null;
  return <p id={id} className="end-company-help company-candidate-status" role="status">
    {state === "error" ? <>候補を取得できませんでした。「新規追加」から入力できます。 <button type="button" className="text-link" onClick={retry}>再取得</button></>
      : state === "loading" ? "保存済みの候補を確認中…" : "新しい会社名は案件の保存時に候補に追加されます。"}
  </p>;
}

function CompanyField({ name, required = false, value, onChange, addingNew, onAddingNewChange, knownCompanies,
  className = "d-label", describedBy, children }: FieldProps & {
    name: "upperCompany" | "endCompany"; required?: boolean; className?: string; describedBy?: string; children?: ReactNode;
  }) {
  const id = useId();
  const label = name === "upperCompany" ? "上位会社" : "エンド企業";
  // Only the select key is trimmed. An untouched legacy project retains its raw value.
  const selectedName = addingNew ? "" : trimCompanyName(value);
  const options = [...new Set([...knownCompanies, selectedName].map(trimCompanyName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const emptyValue = required ? "" : "none";
  const selection = addingNew ? "new" : selectedName ? `company:${selectedName}` : emptyValue;

  return <div className={`end-company-field ${className}`}>
    <label htmlFor={`${id}-selection`}>{label}（{required ? "必須" : "任意"}）</label>
    <select id={`${id}-selection`} name={`${name}Selection`} value={selection} required={required} aria-describedby={describedBy} onChange={event => {
      const selected = event.currentTarget.value;
      onAddingNewChange(selected === "new");
      onChange(selected.startsWith("company:") ? selected.slice(8) : "");
    }}>
      <option value={emptyValue} disabled={required}>{required ? `${label}を選択` : "未入力"}</option>
      {options.map(company => <option key={company} value={`company:${company}`} disabled={company.length > 200}>
        {company}{company.length > 200 ? "（200文字超・既存案件でのみ保持）" : ""}
      </option>)}
      <option value="new">新規追加</option>
    </select>
    {addingNew ? <>
      <label htmlFor={`${id}-new`}>新しい{label}名</label>
      <input id={`${id}-new`} name={name} value={value} required={required} maxLength={200} placeholder="会社名を入力" aria-describedby={describedBy} onChange={event => onChange(event.currentTarget.value)} />
    </> : <input type="hidden" name={name} value={value} />}
    {children}
  </div>;
}

export function SalesCompanyFields({ upper, end }: { upper: FieldProps; end: FieldProps }) {
  const { data, state, retry } = useCandidates(loadCompanyCandidates);
  const statusId = useId();
  const adding = upper.addingNew || end.addingNew;
  const describedBy = state !== "ready" || adding ? statusId : undefined;
  return <div className="sales-company-fields">
    <CompanyField name="upperCompany" required {...upper} knownCompanies={[...upper.knownCompanies, ...(data?.upper ?? [])]} describedBy={describedBy} />
    <CompanyField name="endCompany" {...end} knownCompanies={[...end.knownCompanies, ...(data?.end ?? [])]} describedBy={describedBy} />
    <CandidateStatus state={state} retry={retry} addingNew={adding} id={statusId} />
  </div>;
}

async function loadEndCompanies(signal: AbortSignal): Promise<string[]> {
  const response = await fetch("/api/end-companies", { cache: "no-store", signal });
  const result = await response.json() as { endCompanies?: unknown };
  if (!response.ok || !Array.isArray(result.endCompanies) || !result.endCompanies.every(name => typeof name === "string")) throw new Error("エンド企業の候補を取得できませんでした。");
  return result.endCompanies;
}

export function AdminEndCompanyField(props: FieldProps & { className?: string }) {
  const { data, state, retry } = useCandidates(loadEndCompanies);
  const statusId = useId();
  return <CompanyField name="endCompany" {...props} knownCompanies={[...props.knownCompanies, ...(data ?? [])]} describedBy={state !== "ready" || props.addingNew ? statusId : undefined}>
    <CandidateStatus state={state} retry={retry} addingNew={props.addingNew} id={statusId} />
  </CompanyField>;
}
