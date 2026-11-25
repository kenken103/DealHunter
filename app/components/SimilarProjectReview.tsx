export type ProjectComparison = {
  project: string;
  summary: string;
  upperCompany: string;
  endCompany: string;
};

type ProjectMatch = {
  scope: "own" | "other";
  projectId: string; projectName: string; summary: string;
  score: number; reasons: string[]; salesName: string;
};

export type SimilarProjectNotice =
  | { kind: "matches"; matches: ProjectMatch[] }
  | { kind: "unavailable"; input: ProjectComparison };

function isProjectMatch(value: unknown): value is ProjectMatch {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.score === "number" && Number.isInteger(item.score) && item.score >= 0 && item.score <= 100
    && typeof item.salesName === "string" && Array.isArray(item.reasons) && item.reasons.every(reason => typeof reason === "string")
    && (item.scope === "other" || item.scope === "own") && typeof item.projectId === "string"
    && typeof item.projectName === "string" && typeof item.summary === "string";
}

export async function checkSimilarProjects(input: ProjectComparison): Promise<SimilarProjectNotice | null> {
  try {
    const response = await fetch("/api/similar-projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { kind: "unavailable", input };
    const { matches } = await response.json();
    if (!Array.isArray(matches) || !matches.every(isProjectMatch)) return { kind: "unavailable", input };
    const top = matches.sort((a, b) => b.score - a.score).slice(0, 3);
    return top.length ? { kind: "matches", matches: top } : null;
  } catch {
    return { kind: "unavailable", input };
  }
}

type Props = {
  notice: SimilarProjectNotice;
  checking: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onContinue: () => void;
};

export function SimilarProjectReview({ notice, checking, onRetry, onEdit, onContinue }: Props) {
  if (notice.kind === "unavailable") return <>
    <p className="d-note" role="status">{checking ? "登録済みの案件を照合しています…" : "もう一度照合するか、入力した依頼内容の確認へ進めます。"}</p>
    <div className="sales-dialog-actions">
      <button type="button" className="sales-secondary" disabled={checking} onClick={onRetry}>再試行</button>
      <button type="button" className="d-button" disabled={checking} onClick={onContinue}>確認へ進む</button>
    </div>
  </>;

  return <>
    <p className="d-note">入力内容に近い登録済みの案件です。一致度は案件名・面談概要・会社名の共通点から算出しています。</p>
    <ol className="sales-similar-projects" aria-label="一致度の高い案件">
      {notice.matches.map(match => <li key={match.projectId}>
        <div className="sales-similar-heading">
          <span className="sales-similar-score">一致度 <strong>{match.score}%</strong></span>
          <h3>{match.projectName}</h3>
        </div>
        <p>担当営業　{match.salesName}</p>
        <p>{match.reasons.join(" ／ ")}</p>
        <details>
          <summary>案件を確認</summary>
          <h4>登録済みの面談概要</h4>
          <p className="sales-preserve-lines">{match.summary}</p>
        </details>
      </li>)}
    </ol>
    <div className="sales-dialog-actions">
      <button type="button" className="sales-secondary" onClick={onEdit}>入力に戻る</button>
      <button type="button" className="d-button" onClick={onContinue}>このまま確認へ進む</button>
    </div>
  </>;
}
