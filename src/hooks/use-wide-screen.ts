"use client";

import { useSyncExternalStore } from "react";

/** 横に並べられる広さ(tailwind の lg)。サーバーで描くときは false。 */
export const WIDE_SCREEN_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(WIDE_SCREEN_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useWideScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_SCREEN_QUERY).matches,
    () => false,
  );
}
