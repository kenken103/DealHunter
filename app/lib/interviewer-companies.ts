import { companyComparisonKey, uniqueCompanyNames } from "./company-name";

export const companyRoleLabels = { upper: "上位会社", prime: "元請け", end: "エンド企業" } as const;
export type CompanyRole = keyof typeof companyRoleLabels;
export const manualCompanyRoleLabels = { all: "すべての区分", upper: "上位会社", end: "エンド企業" } as const;
export type ManualCompanyRole = keyof typeof manualCompanyRoleLabels;
type CandidateCompanies = Record<Exclude<ManualCompanyRole, "all">, string[]>;
type ManualRestrictions = Record<ManualCompanyRole, string[]>;
export type CompanyRestrictionDetails = {
  restrictions: ManualRestrictions;
  ownRestrictions: ManualRestrictions;
  historyCompanies: Set<string>;
};

export function companyHistoryKeys(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja").split("→").map(name =>
    name.replace(/[\p{White_Space}\u001C-\u001F\uFEFF]/gu, "")
      .replace(/^(株式会社|有限会社|合同会社|\([株有同]\))|(株式会社|有限会社|合同会社|\([株有同]\))$/g, "")
  ).filter(Boolean);
}

function readNames(value: unknown, role: ManualCompanyRole): string[] {
  if (!value || typeof value !== "object") throw new Error("会社一覧が不正です");
  const list: unknown = Reflect.get(value, role);
  if (!Array.isArray(list) || !list.every(name => typeof name === "string")) throw new Error("会社名が不正です");
  return uniqueCompanyNames(list);
}

function readManualRestrictions(value: unknown): ManualRestrictions {
  return { all: readNames(value, "all"), end: readNames(value, "end"), upper: readNames(value, "upper") };
}

async function fetchCompanyData(url: string, options: RequestInit): Promise<unknown> {
  const timeout = AbortSignal.timeout(8000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...options, cache: "no-store", signal });
  if (!response.ok) throw new Error("会社情報を取得できませんでした");
  return response.json();
}

export async function loadCompanyCandidates(signal: AbortSignal): Promise<CandidateCompanies> {
  const result = await fetchCompanyData("/api/interviewer-company-candidates", { signal });
  return { end: readNames(result, "end"), upper: readNames(result, "upper") };
}

export async function loadRestrictionDetails(studentId: string, options: RequestInit = {}): Promise<CompanyRestrictionDetails> {
  const result = await fetchCompanyData("/api/interviewer-company-restrictions/" + encodeURIComponent(studentId), options);
  if (!result || typeof result !== "object" || !("studentId" in result) || result.studentId !== studentId
    || !("restrictions" in result) || !("ownRestrictions" in result)
    || !("historyCompanies" in result) || !Array.isArray(result.historyCompanies)
    || !result.historyCompanies.every(name => typeof name === "string")) throw new Error("対象面談者の情報を確認できませんでした");
  return {
    restrictions: readManualRestrictions(result.restrictions),
    ownRestrictions: readManualRestrictions(result.ownRestrictions),
    historyCompanies: new Set(result.historyCompanies.flatMap(companyHistoryKeys)),
  };
}

export function isRestricted(companies: ManualRestrictions, role: ManualCompanyRole, name: string) {
  if (role === "all") {
    const keys = companyHistoryKeys(name);
    return companies.all.some(company => companyHistoryKeys(company).some(key => keys.includes(key)));
  }
  const key = companyComparisonKey(name);
  return companies[role].some(company => companyComparisonKey(company) === key);
}

export function companyRestrictionReason(details: CompanyRestrictionDetails, role: CompanyRole, name: string) {
  if (companyHistoryKeys(name).some(key => details.historyCompanies.has(key))) return "面談履歴あり";
  if (isRestricted(details.restrictions, "all", name) || (role !== "prime" && isRestricted(details.restrictions, role, name))) return "NG登録あり";
  return null;
}
