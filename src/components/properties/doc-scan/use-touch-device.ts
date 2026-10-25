"use client";

import { useSyncExternalStore } from "react";

/**
 * スマホ・タブレット(指で操作する端末)かどうか。発注者の指示(2026-10-25):
 * 「書類を撮る」はモバイル機器で開いたときだけ出す。
 * ⚠端末の名乗り(ブラウザが送る端末名)では決めない=iPad の Safari はパソコンを名乗る。画面の操作の仕方で決める。
 * サーバーで描くときは false(パソコンと同じ見た目)→ 端末で確かめてから出す。
 */
export const TOUCH_ONLY_QUERY = "(hover: none) and (pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(TOUCH_ONLY_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useTouchDevice(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(TOUCH_ONLY_QUERY).matches,
    () => false,
  );
}
