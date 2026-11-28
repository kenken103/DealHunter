// Legacy company fields can contain only whitespace, including the API's extra trim characters.
export function companyNameForDisplay(name?: string) {
  return name && /[^\p{White_Space}\u001C-\u001F\uFEFF]/u.test(name) ? name : undefined;
}
// Keep display data intact; use a normalized key for company selection and matching.
export const trimEndCompany = (value: string) => value.replace(/^[\p{White_Space}\u001C-\u001F\uFEFF]+|[\p{White_Space}\u001C-\u001F\uFEFF]+$/gu, "");
export const companyComparisonKey = (value: string) => trimEndCompany(value).normalize("NFKC");

export function uniqueCompanyNames(values: string[]) {
  const names = new Map<string, string>();
  for (const raw of values) {
    const name = trimEndCompany(raw), key = companyComparisonKey(name);
    if (key && !names.has(key)) names.set(key, name);
  }
  return [...names.values()];
}
