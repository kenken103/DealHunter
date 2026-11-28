import type { Recruitment } from "../types";

export default function RecruitmentNgReview({ recruitment }: { recruitment: Recruitment }) {
  const review = recruitment.ngReview;
  if (!review) return null;
  return <section aria-label="NGを確認して選定した記録">
    <h4>NGを確認して選定した記録</h4>
    <p>確認者　{review.reviewerName}{recruitment.assignedAt && " ／ " + new Date(recruitment.assignedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
    <ul>{review.people.map(person => <li key={person.id}>{person.name}　{person.reasons.join(" ／ ")}</li>)}</ul>
  </section>;
}
