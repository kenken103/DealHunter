import { useEffect, useState } from "react";
import type { DashboardData } from "../types";

export default function EngineerPastQuestions({ projectId, data }: { projectId: string; data: DashboardData }) {
  const [groups,setGroups] = useState<{ projectIds: string[] }[]>([]);
  const [failed,setFailed] = useState(false);
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!data.questions.length) return;
    const controller = new AbortController();
    setFailed(false);
    fetch("/api/question-groups", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.groups)) throw new Error();
        if (!controller.signal.aborted) setGroups(body.groups);
      }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setGroups([]); } });
    return () => controller.abort();
  }, [data,attempt]);
  const projects = new Set(groups.find(g => g.projectIds.includes(projectId))?.projectIds ?? [projectId]);
  const questions = data.questions.filter(q => projects.has(q.project));
  return <section className="dh-engineer-section"><h3>この案件・関連案件の過去質問 <span className="question-count">{questions.length}</span></h3>
    {failed && <p role="status">関連案件を読み込めませんでした。<button className="dh-engineer-secondary" onClick={() => setAttempt(x => x + 1)}>再読み込み</button></p>}
    {questions.map((q,i) => {
      const name = data.projects.find(p => p.id === q.project)?.name;
      const round = data.events.find(e => e.key === q.eventId)?.round ?? q.round;
      return <details className="query" key={q.key}><summary><span className="q-no">Q{i+1}</span><strong>{q.title}</strong></summary>
        <p>出典　{name || "案件"}{round ? "　面談 " + round + "回目" : ""}</p>{q.context && <p>{q.context}</p>}</details>;
    })}
    {!questions.length && <p className="dh-engineer-small">登録された質問はありません。</p>}
  </section>;
}
