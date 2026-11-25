import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { backendRequest } from "../../../lib/backend";
import { companyNameForDisplay } from "../../../lib/company-name";
import { getDemoUser, homeFor } from "../../../lib/demo-auth";
import { engineerHistoryLink, engineerStatusLink, validEngineerId } from "../../../lib/return-path";
import type { InterviewFeedback } from "../../../types";
import "./interview-history.css";

export const metadata: Metadata = { title: "面談履歴｜DealHunter" };

const resultLabels = {
  pending: "結果待ち", passed: "合格", rejected: "見送り", advanced: "次回面談へ",
  offered: "オファー", declined: "辞退", joined: "参画", unknown: "未登録",
};

const feedbackFields = [
  ["duties", "業務内容"], ["process", "作業工程"], ["remote", "リモート頻度"], ["impression", "感想"],
] as const;

type HistoryFeedback = Pick<InterviewFeedback, typeof feedbackFields[number][0]>;

type Interview = {
  id: string;
  projectName: string;
  notes: string;
  upperCompany: string;
  primeCompany: string;
  endCompany: string;
  interviewDate: string | null;
  interviewTime: string | null;
  round: number | null;
  totalRounds: number | null;
  result: keyof typeof resultLabels;
  resultText: string | null;
  questions: string[];
  feedback: HistoryFeedback | null;
};

type History = { engineer: { id: string; name: string }; interviews: Interview[] };

function InterviewRecord({ questions = [], feedback }: Pick<Interview, "questions" | "feedback">) {
  return <details className="engineer-history-record">
    <summary>聞かれた質問・面談所感</summary>
    <div className="engineer-history-record-content">
      <h3>聞かれた質問</h3>
      {questions.length ? <ol>{questions.map((question, index) => <li key={index}>{question}</li>)}</ol>
        : <p>質問の記録はありません。</p>}
      <h3>面談所感</h3>
      {feedback ? <dl className="engineer-history-feedback-fields">{feedbackFields.map(([field, label]) =>
        <div key={field}><dt>{label}</dt><dd>{feedback[field]}</dd></div>,
      )}</dl> : <p>面談所感はまだ登録されていません。</p>}
    </div>
  </details>;
}

function InterviewRow({ interview }: { interview: Interview }) {
  const { interviewDate, interviewTime, round, totalRounds, result, resultText } = interview;
  const companies = [
    ["上位会社", companyNameForDisplay(interview.upperCompany) || "未登録"],
    ["元請け", companyNameForDisplay(interview.primeCompany)],
    ["エンド企業", companyNameForDisplay(interview.endCompany)],
  ];

  return <li className="engineer-history-row">
    <div className="engineer-history-date">
      {interviewDate ? <time dateTime={interviewTime ? `${interviewDate}T${interviewTime}` : interviewDate}>
        {interviewDate.replaceAll("-", "/")}{interviewTime && <span>{interviewTime}</span>}
      </time> : <span>面談日未登録</span>}
      {round !== null && <small>第{round}回{totalRounds ? ` ／ 全${totalRounds}回` : ""}</small>}
    </div>
    <div className="engineer-history-project">
      <h2>{interview.projectName}</h2>
      <dl className="engineer-history-companies">{companies.map(([label, name]) => name && <div key={label}><dt>{label}</dt><dd>{name}</dd></div>)}</dl>
      {interview.notes.trim() && <details className="engineer-history-notes"><summary>案件概要</summary><p>{interview.notes}</p></details>}
      <InterviewRecord questions={interview.questions} feedback={interview.feedback} />
    </div>
    <span className="engineer-history-result" data-result={result}>
      {result === "unknown" ? resultText?.trim() || resultLabels.unknown : resultLabels[result]}
    </span>
  </li>;
}

export default async function EngineerInterviewHistoryPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  if (!validEngineerId(studentId)) notFound();

  const historyLink = engineerHistoryLink(studentId);
  const loginLink = `/login?next=${encodeURIComponent(historyLink)}`;
  const user = await getDemoUser();
  if (!user) redirect(loginLink);
  if (user.role !== "sales" && user.role !== "leader") redirect(homeFor(user.role));

  const response = await backendRequest(user, `engineer-interview-history/${studentId}`);
  if (response.status === 401) redirect(loginLink);
  const history: History | null = response.ok ? await response.json() : null;
  const unavailable = response.status === 403 || response.status === 404;
  const backLink = engineerStatusLink(user.role);

  return <>
    <header className="mast"><div className="engineer-history-mast">
      <Link className="logo" href={homeFor(user.role)}><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></Link>
    </div></header>
    <main className="engineer-history">
      <Link className="engineer-history-back" href={backLink}><span aria-hidden="true">←</span>エンジニア状況に戻る</Link>
      <div className="engineer-history-heading">
        <h1>{history ? `${history.engineer.name}の面談履歴` : "面談履歴"}</h1>
        {history && <p>{history.interviews.length}件</p>}
      </div>
      {!history ? <div className="engineer-history-message" role="alert">
        <p>{unavailable ? "このエンジニアの面談履歴は表示できません。" : "面談履歴を読み込めませんでした。"}</p>
        {!unavailable && <a className="text-link" href={historyLink}>再読み込み</a>}
      </div> : history.interviews.length ? <ol className="engineer-history-list" aria-label="過去の面談一覧" role="list">
        {history.interviews.map(interview => <InterviewRow key={interview.id} interview={interview} />)}
      </ol> : <p className="engineer-history-message">過去の面談履歴はありません。</p>}
    </main>
  </>;
}
