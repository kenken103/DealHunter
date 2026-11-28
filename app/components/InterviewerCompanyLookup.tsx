"use client";

import { useEffect, useId, useState } from "react";
import { companyHistoryKeys, companyRoleLabels, type CompanyRole } from "../lib/interviewer-companies";
import { companyComparisonKey } from "../lib/company-name";
import { RestrictionEditor, useCompanyRestrictions } from "./InterviewerCompanyRestrictions";
import "./interviewer-company-lookup.css";

const roles = ["upper", "prime", "end"] as const;
const lookupRoles = [...roles, "all"] as const;
const lookupRoleLabels = { ...companyRoleLabels, all: "全区分のNG登録" };
type Direction = "company" | "engineer";
type LookupRole = (typeof lookupRoles)[number];
type Choice = { key: string; name: string; label: string; role?: LookupRole; ng: Set<string>; historyNg: Set<string> };
type Directory = { companies: Choice[]; engineers: Choice[] };

function searchText(text: string) {
  return text.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/gu, "");
}

function companyKey(role: LookupRole, name: string) {
  return role + ":" + companyComparisonKey(name);
}

function readDirectory(response: unknown): Directory {
  if (!response || typeof response !== "object" || !("companies" in response) || !response.companies
    || typeof response.companies !== "object" || !("students" in response) || !Array.isArray(response.students)
    || !("restrictions" in response) || !Array.isArray(response.restrictions)
    || !("historyCompanies" in response) || !Array.isArray(response.historyCompanies)) throw new Error();

  const companies = new Map<string, Choice>();
  const companyChoicesByHistoryKey = new Map<string, Choice[]>();
  for (const role of lookupRoles) {
    const names: unknown = Reflect.get(response.companies, role);
    if (!Array.isArray(names)) throw new Error();
    for (const name of names) {
      if (typeof name !== "string" || !name) throw new Error();
      const keys = new Set(companyHistoryKeys(name));
      if (role === "all" && keys.size > 0 && [...keys].every(key => companyChoicesByHistoryKey.has(key))) continue;
      const key = companyKey(role, name);
      if (companies.has(key)) continue;
      const choice = { key, name, label: name, role, ng: new Set<string>(), historyNg: new Set<string>() };
      companies.set(key, choice);
      for (const historyKey of keys) {
        const matches = companyChoicesByHistoryKey.get(historyKey) ?? [];
        matches.push(choice);
        companyChoicesByHistoryKey.set(historyKey, matches);
      }
    }
  }
  const engineers = new Map<string, Choice>();
  const nameCounts = new Map<string, number>();
  for (const student of response.students) {
    if (!student || typeof student.id !== "string" || !student.id || typeof student.name !== "string" || !student.name) throw new Error();
    engineers.set(student.id, { key: student.id, name: student.name, label: student.name, ng: new Set(), historyNg: new Set() });
    nameCounts.set(student.name, (nameCounts.get(student.name) ?? 0) + 1);
  }
  for (const engineer of engineers.values()) {
    if ((nameCounts.get(engineer.name) ?? 0) > 1) engineer.label += "（" + engineer.key + "）";
  }
  for (const restriction of response.restrictions) {
    if (!restriction || !lookupRoles.includes(restriction.companyRole) || typeof restriction.companyName !== "string") throw new Error();
    const engineer = engineers.get(restriction.studentId);
    if (!engineer) throw new Error();
    if (restriction.companyRole === "all") {
      for (const company of matchingCompanies(restriction.companyName)) markNg(engineer, company);
      const exactCompany = companies.get(companyKey("all", restriction.companyName));
      if (exactCompany) markNg(engineer, exactCompany);
    } else {
      const company = companies.get(companyKey(restriction.companyRole, restriction.companyName));
      if (!company) throw new Error();
      markNg(engineer, company);
    }
  }
  for (const history of response.historyCompanies) {
    if (!history || typeof history.studentId !== "string" || typeof history.companyName !== "string") throw new Error();
    const engineer = engineers.get(history.studentId);
    if (!engineer) throw new Error();
    for (const company of matchingCompanies(history.companyName)) {
      markNg(engineer, company);
      company.historyNg.add(engineer.key);
      engineer.historyNg.add(company.key);
    }
  }
  const alphabetical = (a: Choice, b: Choice) => a.label.localeCompare(b.label, "ja");
  return { companies: [...companies.values()].sort(alphabetical), engineers: [...engineers.values()].sort(alphabetical) };

  function matchingCompanies(name: string) {
    return companyHistoryKeys(name).flatMap(key => companyChoicesByHistoryKey.get(key) ?? []);
  }
}

function markNg(engineer: Choice, company: Choice) {
  company.ng.add(engineer.key);
  engineer.ng.add(company.key);
}

type LoadResult = { snapshot: object; attempt: number; directory: Directory | null };

function ResultList({ rows, selected, title }: { rows: Choice[]; selected: Choice; title: string }) {
  const sorted = [...rows].sort((a, b) => Number(selected.ng.has(b.key)) - Number(selected.ng.has(a.key)));
  return <section className="ng-lookup-group" aria-label={title}>
    <h4>{title} <span>{rows.length}件</span></h4>
    {rows.length === 0 ? <p className="case-muted">登録はありません。</p> : <ul>
      {sorted.map(row => <li key={row.key}>
        <span>{row.label}{selected.ng.has(row.key) && <small className="ng-lookup-reason">
          {selected.historyNg.has(row.key) ? "面談履歴あり" : "NG登録あり"}
        </small>}</span>
        <strong className={selected.ng.has(row.key) ? "ng-lookup-ng" : "ng-lookup-ok"}>{selected.ng.has(row.key) ? "NG" : "OK"}</strong>
      </li>)}
    </ul>}
  </section>;
}

export default function InterviewerCompanyLookup({ snapshot }: { snapshot: object }) {
  const id = useId();
  const [direction, setDirection] = useState<Direction>("company");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<CompanyRole | "all">("all");
  const [chosen, setChosen] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult>();
  const [ngOnly, setNgOnly] = useState(false);
  const [manualEngineer, setManualEngineer] = useState("");
  const restrictions = useCompanyRestrictions(manualEngineer);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      let directory: Directory | null = null;
      try {
        const response = await fetch("/api/interviewer-company-lookup", {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (response.ok) directory = readDirectory(await response.json());
      } catch { /* Only a validated response can establish an OK status. */ }
      if (!controller.signal.aborted) setResult({ snapshot, attempt, directory });
    }
    void load();
    return () => controller.abort();
  }, [snapshot, attempt]);

  const directory = result?.snapshot === snapshot && result.attempt === attempt ? result.directory : undefined;
  const byCompany = direction === "company";
  const needle = searchText(query);
  const companyNeedles = byCompany ? companyHistoryKeys(query) : [];
  const choices = (byCompany ? directory?.companies : directory?.engineers) ?? [];
  const options = needle ? choices.filter(choice =>
    (!byCompany || role === "all" || choice.role === role || choice.role === "all") &&
    (searchText(choice.label).includes(needle) ||
      companyHistoryKeys(choice.name).some(key => companyNeedles.some(q => key.includes(q))))) : [];
  const exact = options.filter(choice => searchText(choice.name) === needle);
  const selected = options.find(choice => choice.key === chosen) ?? (options.length === 1 ? options[0] : exact.length === 1 ? exact[0] : undefined);
  const rows = (byCompany ? directory?.engineers : directory?.companies) ?? [];

  const displayed = ngOnly && selected ? rows.filter(row => selected.ng.has(row.key)) : rows;

  function changeDirection(next: Direction) {
    if (next === direction) return;
    setDirection(next); setQuery(""); setChosen("");
  }

  return <section className="ng-lookup" aria-labelledby={id}>
    <h2 id={id}>取引先・エンジニアから検索</h2>
    <p className="ng-lookup-explainer">上位会社・元請け・エンド企業のうち、過去の面談先と1社でも一致する場合はNGです。営業が登録したNGも反映します。</p>
    <div className="ng-lookup-controls">
      <div className="ng-lookup-switch" role="group" aria-label="検索方法">
        <button type="button" aria-pressed={byCompany} onClick={() => changeDirection("company")}>会社から探す</button>
        <button type="button" aria-pressed={!byCompany} onClick={() => changeDirection("engineer")}>エンジニアから探す</button>
      </div>
      {byCompany && <label>会社区分<select value={role} onChange={event => { setRole(event.target.value as typeof role); setChosen(""); }}>
        <option value="all">すべて（上位会社・元請け・エンド企業）</option>
        {roles.map(item => <option key={item} value={item}>{companyRoleLabels[item]}</option>)}
      </select></label>}
      <label className="ng-lookup-search">{byCompany ? "会社名を検索" : "エンジニア名を検索"}
        <input type="search" value={query} onChange={event => { setQuery(event.target.value); setChosen(""); }} placeholder={byCompany ? "会社名の一部を入力" : "氏名の一部を入力"} />
      </label>
    </div>
    <details className="ng-manual">
      <summary>面談担当NGを手動登録・解除</summary>
      <p>登録したNGは全営業で共有され、上位会社・元請け・エンド企業のすべてに適用されます。</p>
      <label>エンジニア<select value={manualEngineer} disabled={restrictions.saving || !directory}
        onChange={event => setManualEngineer(event.target.value)}>
        <option value="">エンジニアを選択</option>
        {directory?.engineers.map(engineer => <option key={engineer.key} value={engineer.key}>{engineer.label}</option>)}
      </select></label>
      {manualEngineer && <RestrictionEditor key={manualEngineer} state={restrictions}
        companyNames={[...new Set(directory?.companies.map(company => company.name))]}
        onUpdated={() => setAttempt(value => value + 1)} />}
    </details>
    {directory === undefined ? <p role="status">面談担当NGを確認中…</p>
      : directory === null ? <p role="alert">面談担当NGを取得できませんでした。 <button type="button" className="text-link" onClick={() => setAttempt(value => value + 1)}>再取得</button></p>
      : needle && <>
        <p role="status" className="ng-lookup-summary">{options.length === 0
          ? (byCompany ? "該当する会社はありません。" : "該当するエンジニアはいません。")
          : options.length > 1 ? `候補 ${options.length}件。確認する${byCompany ? "会社" : "エンジニア"}を選択してください。`
          : `${byCompany ? "該当する会社" : "該当するエンジニア"} 1件`}</p>
        {options.length > 1 && <div className="ng-lookup-options" role="group" aria-label="検索候補">
          {options.map(choice => <button type="button" key={choice.key} aria-pressed={selected?.key === choice.key} onClick={() => setChosen(choice.key)}>
            <span>{choice.role && <small>{lookupRoleLabels[choice.role]} </small>}{choice.label}</span>
            <span className="ng-lookup-counts"><b>NG {choice.ng.size}</b> / OK {rows.length - choice.ng.size}</span>
          </button>)}
        </div>}
        {selected && <div className="ng-lookup-results">
          <h3>{selected.role && <small>{lookupRoleLabels[selected.role]} </small>}{selected.label}</h3>
          <p className="ng-lookup-totals"><strong>NG {selected.ng.size}</strong> / OK {rows.length - selected.ng.size}</p>
          <label><input type="checkbox" checked={ngOnly} onChange={e => setNgOnly(e.target.checked)} /> NGのみ表示</label>
          {ngOnly && !displayed.length ? <p role="status">該当するNGはありません。</p> : byCompany ? <ResultList rows={displayed} selected={selected} title="エンジニア" /> : lookupRoles.map(item => {
            const companies = displayed.filter(row => row.role === item);
            return (item !== "all" || companies.length > 0) && <ResultList key={item} rows={companies} selected={selected} title={lookupRoleLabels[item]} />;
          })}
        </div>}
      </>}
  </section>;
}
