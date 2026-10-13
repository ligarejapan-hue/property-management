/**
 * 控えの書き手(設計書 §4.1・§5.1)。React に依存しない(タイマーだけ)=単体で試せる。
 * - update は約1秒間引く。flush は待っている分をすぐ書く(メニューで移る=unmount の瞬間)。
 * - close の後は一切書かない(保存・キャンセル直後の unmount で控えを書き戻さないため)。
 */
import { clearDraft, writeDraft, type WriteResult } from "./draft-store";

export const DRAFT_WRITE_DELAY_MS = 1000;

export interface DraftWriter<T> {
  update(data: T): void;
  flush(): void;
  discard(): void;
  close(): void;
  markSubmitting(): void;
  unmarkSubmitting(): void;
}

export function createDraftWriter<T>(opts: {
  key: string;
  isEmpty: (data: T) => boolean;
  initialPendingAt?: number | null;
  delayMs?: number;
  now?: () => number;
  onResult?: (r: WriteResult) => void;
}): DraftWriter<T> {
  const delay = opts.delayMs ?? DRAFT_WRITE_DELAY_MS;
  const now = opts.now ?? Date.now;
  let latest: { data: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let tooLarge = false;
  let pendingAt: number | null = opts.initialPendingAt ?? null;

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const write = () => {
    cancelTimer();
    if (closed || tooLarge || latest == null) return;
    if (pendingAt == null && opts.isEmpty(latest.data)) {
      clearDraft(opts.key);
      return;
    }
    const r = writeDraft(opts.key, {
      v: 1,
      savedAt: now(),
      data: latest.data,
      ...(pendingAt != null ? { pendingSubmit: { at: pendingAt } } : {}),
    });
    if (r === "too_large") {
      tooLarge = true;
      clearDraft(opts.key);
    }
    opts.onResult?.(r);
  };

  return {
    update(data) {
      if (closed) return;
      latest = { data };
      cancelTimer();
      timer = setTimeout(write, delay);
    },
    flush() {
      write();
    },
    discard() {
      cancelTimer();
      latest = null;
      pendingAt = null;
      clearDraft(opts.key);
    },
    close() {
      cancelTimer();
      closed = true;
      latest = null;
      clearDraft(opts.key);
    },
    markSubmitting() {
      if (closed) return;
      pendingAt = now();
      write();
    },
    unmarkSubmitting() {
      if (closed) return;
      pendingAt = null;
      write();
    },
  };
}
