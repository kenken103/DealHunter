// Legacy company fields can contain only whitespace, including the API's extra trim characters.
export function companyNameForDisplay(name?: string) {
  return name && /[^\p{White_Space}\u001C-\u001F\uFEFF]/u.test(name) ? name : undefined;
}
// Match company validation on the API; similar spellings remain separate choices.
export const trimEndCompany = (value: string) => value.replace(/^[\p{White_Space}\u001C-\u001F\uFEFF]+|[\p{White_Space}\u001C-\u001F\uFEFF]+$/gu, "");
