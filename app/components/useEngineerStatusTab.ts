"use client";

import { useSearchParams } from "next/navigation";

function setEngineerStatusTab(active: boolean) {
  const url = new URL(window.location.href);
  if ((url.searchParams.get("view") === "engineers") === active) return;
  if (active) url.searchParams.set("view", "engineers");
  else url.searchParams.delete("view");
  window.history.replaceState(null, "", url);
}

export function useEngineerStatusTab() {
  const active = useSearchParams().get("view") === "engineers";
  return [active, setEngineerStatusTab] as const;
}
