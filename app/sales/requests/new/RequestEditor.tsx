"use client";

import { useEffect, useState } from "react";
import { NewInterviewRequestForm } from "../../../components/PreviewDialog";
import { newInterviewRequestLink, newInterviewRequestPath } from "../../../lib/return-path";
import type { RequestDraft, RequestDraftSummary } from "../../../lib/request-draft";
import type { DashboardData } from "../../../types";
import DraftList from "./DraftList";

function closeEditor() {
  const referrer = document.referrer && new URL(document.referrer);
  if (referrer && referrer.origin === window.location.origin &&
      (referrer.pathname === "/sales" || referrer.pathname === newInterviewRequestPath)) {
    window.close();
    // A browser that keeps this tab open can still leave the editor.
    window.setTimeout(() => { if (!window.closed) window.location.replace("/sales"); }, 150);
  } else {
    window.location.replace("/sales");
  }
}

type DraftLoad = { draft: RequestDraft } | { error: string };

export default function RequestEditor({ data, initialDraftId }: { data: DashboardData; initialDraftId?: string }) {
  const [loaded, setLoaded] = useState<DraftLoad | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [editingId, setEditingId] = useState(initialDraftId);

  useEffect(() => {
    if (!initialDraftId) return;
    const controller = new AbortController();
    async function loadDraft(id: string) {
      try {
        const response = await fetch("/api/request-drafts/" + encodeURIComponent(id), {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        if (!response.ok) throw new Error(response.status === 404
          ? "この下書きは見つかりません。自分の下書きから選び直してください。"
          : "下書きを読み込めませんでした。もう一度お試しください。");
        const draft: RequestDraft = await response.json();
        if (!controller.signal.aborted) setLoaded({ draft });
      } catch (error) {
        if (!controller.signal.aborted) setLoaded({ error: error instanceof Error && error.name === "Error"
          ? error.message : "下書きを読み込めませんでした。もう一度お試しください。" });
      }
    }
    void loadDraft(initialDraftId);
    return () => controller.abort();
  }, [initialDraftId]);

  function draftSaved(summary: RequestDraftSummary) {
    setEditingId(summary.id);
    window.history.replaceState(window.history.state, "", newInterviewRequestLink(summary.id));
    setCatalogVersion(version => version + 1);
  }

  async function requestCreated() {
    setEditingId(undefined);
    window.history.replaceState(window.history.state, "", newInterviewRequestPath);
    setCatalogVersion(version => version + 1);
    if (typeof BroadcastChannel === "function") {
      const channel = new BroadcastChannel(newInterviewRequestPath);
      channel.postMessage("created");
      channel.close();
    }
  }

  return <>
    <DraftList editingId={editingId} version={catalogVersion} />
    {initialDraftId && !loaded ? <p role="status" className="request-load-error">下書きを読み込んでいます…</p>
      : loaded && "error" in loaded ? <section className="request-load-error">
        <h1>面談依頼の下書き</h1><p role="alert">{loaded.error}</p>
        <a className="text-link" href={newInterviewRequestLink(initialDraftId)}>再読み込み</a>
        <a className="text-link" href={newInterviewRequestPath}>新しい面談依頼を作成</a>
      </section> : <NewInterviewRequestForm data={data} initialDraft={loaded && "draft" in loaded ? loaded.draft : undefined}
        onDraftSaved={draftSaved} onClose={closeEditor} onSaved={requestCreated} />}
  </>;
}
