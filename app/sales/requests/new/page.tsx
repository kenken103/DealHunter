import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { backendRequest } from "../../../lib/backend";
import { getDemoUser, homeFor } from "../../../lib/demo-auth";
import { newInterviewRequestLink } from "../../../lib/return-path";
import type { DashboardData } from "../../../types";
import RequestEditor from "./RequestEditor";
import "./new-request.css";

export const metadata: Metadata = { title: "面談依頼を作成｜DealHunter" };

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const { draft } = await searchParams;
  const requestLink = newInterviewRequestLink(draft);
  const loginUrl = `/login?next=${encodeURIComponent(requestLink)}`;
  const user = await getDemoUser();
  if (!user) redirect(loginUrl);
  if (user.role !== "sales") redirect(homeFor(user.role));

  const response = await backendRequest(user, "dashboard");
  if (response.status === 401) redirect(loginUrl);
  if (response.status === 403) redirect("/");
  const data: DashboardData | null = response.ok ? await response.json() : null;

  return <>
    <header className="mast"><div className="request-mast-inner">
      <div className="logo"><img src="/logo.svg" width="38" height="38" alt="" /><span>DealHunter</span></div>
      <div className="request-account"><span>営業</span>{user.name}</div>
    </div></header>
    <main className="request-editor">
      {data ? <RequestEditor data={data} initialDraftId={typeof draft === "string" && requestLink.includes("?") ? draft : undefined} /> : <section className="request-load-error">
        <h1>面談依頼を作成</h1>
        <p role="alert">面談依頼に必要な情報を読み込めませんでした。</p>
        <a className="text-link" href={requestLink}>再読み込み</a>
      </section>}
    </main>
  </>;
}
