"use client";

import { useSearchParams } from "next/navigation";

export function setScreenParams(values: Record<string, string | null>, push = false) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function useScreenParam(key: string, fallback = "") {
  const value = useSearchParams().get(key) || fallback;
  return [value, (next: string) => setScreenParams({ [key]: next === fallback ? null : next })] as const;
}
