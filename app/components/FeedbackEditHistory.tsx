import type { InterviewFeedback } from "../types";

export default function FeedbackEditHistory({ feedback }: { feedback: InterviewFeedback }) {
  if (!feedback.edits?.length) return null;
  return <details className="feedback-edit-history"><summary>所感の訂正履歴（{feedback.edits.length}件）</summary>
    {feedback.edits.map(edit => <section key={edit.revision}><strong>{new Date(edit.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}　訂正理由</strong>
      <p>{edit.reason}</p><details><summary>訂正前の内容</summary>
        <dl>{[["業務内容", edit.previous.duties], ["工程", edit.previous.process], ["リモート頻度", edit.previous.remote], ["所感", edit.previous.impression]].map(([label,value]) =>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <strong>聞かれた質問</strong><ol>{edit.previous.questions.map((q,i) => <li key={i}>{q}</li>)}</ol>
      </details></section>)}
  </details>;
}
