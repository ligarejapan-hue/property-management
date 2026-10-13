"use client";
/**
 * 作業中の入力の控え(設計書 §4.1)。
 * ⚠useRestoredDraft は useState の初期化で sessionStorage を読む=サーバー描画の最初の出力に
 *   含まれない部品(開いたときだけ描く小窓)でだけ使う。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { hasDraft, readDraft, subscribeDrafts, type StoredDraft } from "@/lib/drafts/draft-store";
import { createDraftWriter } from "@/lib/drafts/draft-writer";

/** 開いた時点の控えを1回だけ読む(key が null なら控えを使わない)。 */
export function useRestoredDraft<T>(key: string | null, parse: (d: unknown) => T | null): StoredDraft<T> | null {
  const [restored] = useState(() => (key ? readDraft(key, parse) : null));
  return restored;
}

/** 入力が変わるたびに控えを書く(約1秒間引き・離れるときは即時)。 */
export function useDraftAutosave<T>(
  key: string | null,
  data: T,
  isEmpty: (d: T) => boolean,
  restored: StoredDraft<T> | null,
) {
  const [tooLarge, setTooLarge] = useState(false);
  const [writer] = useState(() =>
    key
      ? createDraftWriter<T>({
          key,
          isEmpty,
          initialPendingAt: restored?.pendingSubmit?.at ?? null,
          onResult: (r) => {
            if (r === "too_large") setTooLarge(true);
          },
        })
      : null,
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
