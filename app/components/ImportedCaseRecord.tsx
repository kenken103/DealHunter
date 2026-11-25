import type { ImportedCase } from "../types";

export function importedCaseStage(record: ImportedCase) {
  if (record.status === "joined") return "参画（入場済み）";
  return record.outcome || "結果未登録";
}

export function ImportedCaseRecord({ record }: { record: ImportedCase }) {
  const facts = [
    ["面談日", record.interviewDate || "未入力"],
    ["面談結果", record.outcome || "未入力"],
    ["入場日", record.entryDate || record.entryDateText || "未入力"],
  ];
  return <dl className="case-facts">{facts.map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
