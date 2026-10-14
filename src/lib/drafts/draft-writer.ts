/**
 * 控えの書き手(設計書 §4.1・§5.1)。React に依存しない(タイマーだけ)=単体で試せる。
 * - update は約1秒間引く。flush は待っている分をすぐ書く(メニューで移る=unmount の瞬間)。
 * - close の後は一切書かない(保存・キャンセル直後の unmount で控えを書き戻さないため)。
 */
import { clearDraft, writeDraft, type WriteResult } from "./draft-store";

export const DRAFT_WRITE_DELAY_MS = 1000;

/**
 * 鍵ごとの「いま画面に出ている書き手」。⚠画面を離れても、返事を待っている処理は古い書き手を
 *   持ったまま動き続ける。戻ってきた画面が持ち主になった後に古い書き手が届いた返事で
 *   close・discard・書き込みをすると、新しい作業や送信中の印を消してしまう(@codex P1)。
 *   同じタブの中だけの話なので、モジュールの変数で足りる(読み込み直せば古い処理は消える)。
 */
const owners = new Map<string, object>();

export interface DraftWriter<T> {
  update(data: T): void;
  flush(): void;
  discard(): void;
  close(): void;
  markSubmitting(): void;
  unmarkSubmitting(): void;
  /** この書き手を鍵の持ち主にする(画面に出たとき)。以後、他の書き手は控えを変えない。 */
  claim(): void;
}

export function createDraftWriter<T>(opts: {
  key: string;
  isEmpty: (data: T) => boolean;
  initialPendingAt?: number | null;
  delayMs?: number;
  now?: () => number;
  onResult?: (r: WriteResult) => void;
  /**
   * 大きすぎて控えを止めた後でも、送信中の印だけは残すための小さな中身(@codex P2)。
   * 無ければ印も残せない(その画面は送信中の印を使わない前提)。
   */
  compactForPending?: (data: T) => T;
}): DraftWriter<T> {
  const delay = opts.delayMs ?? DRAFT_WRITE_DELAY_MS;
  const now = opts.now ?? Date.now;
  let latest: { data: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let tooLarge = false;
  let pendingAt: number | null = opts.initialPendingAt ?? null;
  const token = {};
  /** 持ち主がいない(claim を使わない書き手)か、自分が持ち主のときだけ控えを変える。 */
  const owns = () => {
    const o = owners.get(opts.key);
    return o === undefined || o === token;
  };

  const cancelTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const write = () => {
    cancelTimer();
    if (closed || latest == null || !owns()) return;
    if (tooLarge) {
      writePendingOnly(latest.data);
      return;
    }
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
      writePendingOnly(latest.data);
    }
    opts.onResult?.(r);
  };

  /**
   * 大きすぎて止まった後: 送信中なら小さな中身で印だけを残す(返事が来ずに離れても、戻ったとき
   * 「登録されたか確かめて」を出す=二重登録を防ぐ)。送信中でなければ控えを消す。
   */
  const writePendingOnly = (data: T) => {
    if (pendingAt == null || !opts.compactForPending) {
      clearDraft(opts.key);
      return;
    }
    const r = writeDraft(opts.key, {
      v: 1,
      savedAt: now(),
      data: opts.compactForPending(data),
      pendingSubmit: { at: pendingAt },
    });
    if (r !== "ok") clearDraft(opts.key);
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
      if (owns()) clearDraft(opts.key);
    },
    close() {
      cancelTimer();
      closed = true;
      latest = null;
      if (owns()) clearDraft(opts.key);
    },
    claim() {
      owners.set(opts.key, token);
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
