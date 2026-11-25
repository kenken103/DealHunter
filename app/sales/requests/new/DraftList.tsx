"use client";

import { useEffect, useRef, useState } from "react";
import type { RequestDraftSummary } from "../../../lib/request-draft";
import { newInterviewRequestLink } from "../../../lib/return-path";

const savedDate = new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" });

export default function DraftList({ editingId, version }: { editingId?: string; version: number }) {
  const [drafts, setDrafts] = useState<RequestDraftSummary[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [confirm, setConfirm] = useState<RequestDraftSummary | null>(null);
  const shelf = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/request-drafts", {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error();
        const result: { drafts: RequestDraftSummary[] } = await response.json();
        if (!controller.signal.aborted) { setDrafts(result.drafts); setError(""); }
      } catch {
        if (!controller.signal.aborted) setError("下書き一覧を読み込めませんでした。");
      }
    }
    void load();
    return () => controller.abort();
  }, [version, reload]);

  useEffect(() => {
    const refresh = () => { if (shelf.current?.open) setReload(value => value + 1); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function removeDraft(draft: RequestDraftSummary) {
    if (removing) return;
    setRemoving(true);
    try {
      const response = await fetch("/api/request-drafts/" + encodeURIComponent(draft.id), {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: draft.revision }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        setError(response.status === 409 ? "別のタブで下書きが更新されました。一覧を再読み込みしてください。" : "下書きを削除できませんでした。");
      } else {
        setDrafts(current => current?.filter(item => item.id !== draft.id) ?? null);
        setError("");
      }
    } catch {
      setError("下書きの削除結果を確認できませんでした。一覧を再読み込みしてください。");
    } finally {
      setRemoving(false);
      setConfirm(null);
    }
  }

  return <details className="request-draft-list" ref={shelf} onToggle={event => {
    if (event.currentTarget.open) setReload(value => value + 1);
  }}>
    <summary>自分の下書き{drafts && <span>{drafts.length}件</span>}</summary>
    {error && <p role="alert">{error} <button className="text-link" type="button" onClick={() => setReload(value => value + 1)}>再読み込み</button></p>}
    {!drafts && !error && <p role="status">読み込み中…</p>}
    {drafts?.length === 0 && <p>一時保存した面談依頼はありません。</p>}
    {drafts && drafts.length > 0 && <ul>
      {drafts.map(draft => <li key={draft.id}>
        <div className="draft-identification">
          <strong>{draft.title || "案件名未入力"}</strong>
          <time dateTime={draft.updatedAt}>{savedDate.format(new Date(draft.updatedAt))} 保存</time>
        </div>
        {editingId === draft.id ? <span>編集中</span> : confirm?.id === draft.id ? <div className="draft-actions">
          <span>この下書きを削除しますか？</span>
          <button type="button" disabled={removing} onClick={() => setConfirm(null)}>キャンセル</button>
          <button type="button" disabled={removing} onClick={() => void removeDraft(confirm)}>削除する</button>
        </div> : <div className="draft-actions">
          <a href={newInterviewRequestLink(draft.id)}>再開</a>
          <button type="button" disabled={removing} onClick={() => setConfirm(draft)}>削除</button>
        </div>}
      </li>)}
    </ul>}
  </details>;
}
