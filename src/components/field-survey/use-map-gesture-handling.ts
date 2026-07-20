"use client";

import { useSyncExternalStore } from "react";

/**
 * 地図の gestureHandling をタッチ端末とPCで切替えるための共有フック。
 *
 * - タッチ入力が可能な端末(any-pointer:coarse)は "cooperative"
 *   (1本指=ページスクロール / 2本指=地図移動)。地図が画面を占有して周囲の UI に
 *   触れなくなる問題を避ける。
 * - タッチ非対応の PC(マウスのみ)は従来どおり "greedy"(1本指で地図移動)。
 *
 * `pointer: coarse` は「主ポインタ」だけを見るため、タッチ対応ノートPC+マウスの
 * ようなハイブリッド機ではマウスが主扱いになり false になる → 画面をタッチすると
 * 占有問題が再発する。タッチ入力の有無で判定したいので `any-pointer: coarse`
 * (いずれかのポインタがタッチ)を使う。
 *
 * SSR/lint 安全のため useSyncExternalStore + matchMedia で購読する
 * (effect 内 setState を避ける)。現地調査マップ本体と履歴マップの両方で共有する。
 */
function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(any-pointer: coarse)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getCoarsePointerSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(any-pointer: coarse)").matches
  );
}

// SSR スナップショット: サーバでは判定不能なので false(PC 既定=greedy)。
// ハイドレート後にクライアントで再評価され、タッチ端末なら cooperative へ切り替わる。
function getCoarsePointerServerSnapshot(): boolean {
  return false;
}

export function useMapGestureHandling(): "cooperative" | "greedy" {
  const isCoarsePointer = useSyncExternalStore(
    subscribeCoarsePointer,
    getCoarsePointerSnapshot,
    getCoarsePointerServerSnapshot,
  );
  return isCoarsePointer ? "cooperative" : "greedy";
}
