"use client";

import { useSyncExternalStore } from "react";

/**
 * 現地調査マップの狭い画面(Tailwind の sm 未満)。右上の「表示切替」と左上の Google の
 * 「地図／航空写真」が 320px で重なった(実機確認 2026-10-28)ため、狭い画面だけ
 * Google の切替を1つのボタン(押すと選べる形)にして幅を詰める。
 */
export const NARROW_MAP_QUERY = "(max-width: 639px)";

/** google.maps.MapTypeControlStyle.DROPDOWN_MENU。描画時に google を読まずに済むよう数値で持つ。 */
const DROPDOWN_MENU = 2;

/** 狭い画面だけ切替を1つのボタンにする。広い画面は Google の既定のまま(undefined)。 */
export function mapTypeControlOptionsFor(narrow: boolean): { style: number } | undefined {
  return narrow ? { style: DROPDOWN_MENU } : undefined;
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(NARROW_MAP_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** 狭い画面かどうか。サーバー描画では false(広い画面の既定)。 */
export function useNarrowMap(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_MAP_QUERY).matches,
    () => false,
  );
}
