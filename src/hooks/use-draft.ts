"use client";
/**
 * 作業中の入力の控え(設計書 §4.1)。
 * ⚠useRestoredDraft は useState の初期化で sessionStorage を読む=サーバー描画の最初の出力に
 *   含まれない部品(開いたときだけ描く小窓)でだけ使う。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { hasDraft, readDraft, subscribeDrafts, type StoredDraft } from "@/lib/drafts/draft-store";
import { createDraftWriter } from "@/lib/drafts/draft-writer";

/**
 * 開いた時点の控えを1回だけ読む(key が null なら控えを使わない)。
 * 鍵が変わったら(別の物件など)その鍵で読み直す。
 */
export function useRestoredDraft<T>(key: string | null, parse: (d: unknown) => T | null): StoredDraft<T> | null {
  const [state, setState] = useState(() => ({ key, value: key ? readDraft(key, parse) : null }));
  if (state.key !== key) {
    const next = { key, value: key ? readDraft(key, parse) : null };
    setState(next);
    return next.value;
  }
  return state.value;
}

/** 入力が変わるたびに控えを書く(約1秒間引き・離れるときは即時)。 */
export function useDraftAutosave<T>(
  key: string | null,
  data: T,
  isEmpty: (d: T) => boolean,
  restored: StoredDraft<T> | null,
  opts: { compactForPending?: (d: T) => T } = {},
) {
  const compactForPending = opts.compactForPending;
  const [tooLarge, setTooLarge] = useState(false);
  // 鍵が変わったら作り直す(前の鍵へ書き続けない)。前の書き手は下の片付けで flush される。
  const writer = useMemo(
    () =>
      key
        ? createDraftWriter<T>({
            key,
            isEmpty,
            initialPendingAt: restored?.pendingSubmit?.at ?? null,
            compactForPending,
            onResult: (r) => {
              if (r === "too_large") setTooLarge(true);
            },
          })
        : null,
    [key, isEmpty, restored, compactForPending],
  );

  useEffect(() => {
    writer?.update(data);
  }, [writer, data]);

  useEffect(() => {
    if (!writer) return;
    const onHide = () => writer.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      writer.flush();
    };
  }, [writer]);

  return {
    tooLarge,
    discard: () => writer?.discard(),
    close: () => writer?.close(),
    markSubmitting: () => writer?.markSubmitting(),
    unmarkSubmitting: () => writer?.unmarkSubmitting(),
  };
}

/** 控えがあるか(小窓の自動再オープン用)。サーバー描画では常に false。 */
export function useDraftExists(key: string | null): boolean {
  return useSyncExternalStore(
    subscribeDrafts,
    () => (key ? hasDraft(key) : false),
    () => false,
  );
}

const subscribeNothing = () => () => {};

/**
 * ブラウザで描き直した後なら true(サーバー描画と hydration 中は false)。
 * ⚠ページ(最初にサーバーで描かれる画面)で控えを読むときは、これが true になってから
 *   画面本体を作り直す(key を変える)。サーバー描画の結果と食い違わないようにするため。
 *   クライアント遷移(メニューで移ってきた)では最初から true なので作り直しは起きない。
 */
export function useClientReady(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}
