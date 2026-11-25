"use client";

import { useEffect, useState } from "react";
import { companyNameForDisplay } from "../lib/company-name";
import type { DashboardData, Question, ScheduleEvent } from "../types";
import { meetingDate } from "./MeetingRecord";
import "./question-library.css";

type ProjectGroup = { projectIds: string[]; companyName: string | null };
type InterviewQuestions = { event?: ScheduleEvent; projectName: string; questions: Question[] };
type QuestionSource = Pick<DashboardData, "projects" | "questions" | "events">;

function readGroups(data: unknown): ProjectGroup[] {
  if (!data || typeof data !== "object" || !("groups" in data) || !Array.isArray(data.groups)) throw new Error();
  for (const group of data.groups) {
    if (!group || !Array.isArray(group.projectIds) || !group.projectIds.length ||
      !group.projectIds.every((id: unknown) => typeof id === "string" && id.length) ||
      (group.companyName !== null && typeof group.companyName !== "string")) throw new Error();
  }
  return data.groups;
}

function questionGroups(data: QuestionSource, groups: ProjectGroup[]) {
  const projects = new Map(data.projects.map(project => [project.id, project]));
  const events = new Map(data.events.filter(event => !event.entry).map(event => [event.key, event]));
  const projectQuestions = new Map<string, Question[]>();
  for (const question of data.questions) {
    const questions = projectQuestions.get(question.project) ?? [];
    questions.push(question);
    projectQuestions.set(question.project, questions);
  }

  const seen = new Set<string>();
  const singleProjects = [...projectQuestions.keys()].map(id => ({ projectIds: [id], companyName: null }));
  return [...groups, ...singleProjects].flatMap(group => {
    const projectIds = [...new Set(group.projectIds)].filter(id => projectQuestions.has(id) && !seen.has(id));
    if (!projectIds.length) return [];
    const interviews = new Map<string, InterviewQuestions>();
    let questionCount = 0;
    for (const id of projectIds) {
      seen.add(id);
      for (const question of projectQuestions.get(id) ?? []) {
        const source = question.eventId ? events.get(question.eventId) : undefined;
        const event = source?.projectId === id ? source : undefined;
        const key = event ? "event:" + event.key : "project:" + id;
        const entry = interviews.get(key) ?? {
          event, projectName: projects.get(id)?.name || event?.project || "案件名未登録", questions: [],
        };
        entry.questions.push(question);
        interviews.set(key, entry);
        questionCount++;
      }
    }
    const project = projects.get(projectIds[0]);
    const companyName = group.companyName ||
      [project?.endCompany, project?.primeCompany, project?.upperCompany].map(companyNameForDisplay).find(Boolean);
    const ordered = [...interviews.values()].sort((a, b) =>
      (b.event?.stamp ?? -1) - (a.event?.stamp ?? -1) || (b.event?.time ?? "").localeCompare(a.event?.time ?? ""));
    return [{ id: projectIds[0], name: project?.name || ordered[0].projectName, companyName,
      projectCount: projectIds.length, questionCount, interviews: ordered }];
  });
}

export default function QuestionLibrary({ data, onEvent }: { data: QuestionSource; onEvent: (event: ScheduleEvent) => void }) {
  const [result, setResult] = useState<ProjectGroup[] | null>();
  const [attempt, setAttempt] = useState(0);
  const { questions } = data;

  useEffect(() => {
    if (!questions.length) return;
    const controller = new AbortController();
    async function loadGroups() {
      try {
        const response = await fetch("/api/question-groups", {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw new Error();
        const groups = readGroups(await response.json());
        if (!controller.signal.aborted) setResult(groups);
      } catch {
        if (!controller.signal.aborted) setResult(null);
      }
    }
    void loadGroups();
    return () => controller.abort();
  }, [questions, attempt]);

  if (!questions.length) return <div className="question-library-message">面談後に提出された質問がここに表示されます。</div>;
  const groups = questionGroups(data, result ?? []);
  return <section className="question-library" aria-label="案件別の質問">
    {result === undefined && <p className="question-library-message" role="status">同じ会社の類似案件を確認中です。</p>}
    {result === null && <p className="question-library-message" role="alert">
      類似案件を確認できなかったため、案件別に表示しています。{" "}
      <button type="button" className="text-link" onClick={() => { setResult(undefined); setAttempt(value => value + 1); }}>再読み込み</button>
    </p>}
    {groups.map(group => <details className="question-project-group" key={group.id}>
      <summary>
        {group.companyName && <span className="question-group-company">{group.companyName}</span>}
        <strong>{group.name}</strong>
        <span className="question-group-counts">
          {group.projectCount > 1 && `類似案件を含む ${group.projectCount}案件・`}
          {group.questionCount}件の質問
        </span>
        <svg className="icon" aria-hidden="true"><use href="/icons.svg#i-chevright" /></svg>
      </summary>
      <div className="question-interviews">
        {group.interviews.map(({ event, projectName, questions: records }) => <section className="question-interview" key={records[0].key}>
          <div className="question-interview-heading">
            <div>
              <h2>{projectName}</h2>
              <p>{event ? `${meetingDate(event)} · ${event.person}${event.round > 1 ? ` · 第${event.round}回` : ""}` : "面談日時の記録なし"}</p>
            </div>
            {event && <button type="button" className="text-link" onClick={() => onEvent(event)}>この面談を見る</button>}
          </div>
          <ul>
            {records.map(record => <li key={record.key}>
              <strong>{record.title}</strong>
              {record.tag && record.tag !== "面談記録" && <small>{record.tag}</small>}
              {record.context && <details className="question-context"><summary>記録を読む</summary><p>{record.context}</p></details>}
            </li>)}
          </ul>
        </section>)}
      </div>
    </details>)}
  </section>;
}
