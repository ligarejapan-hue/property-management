/**
 * 通知 段階4b(Web プッシュの送信)の決まりごと。**純関数と定数だけ**(設計書 §7.2〜§7.5)。
 *
 * - ref_key(1通に含めた件の印)は ID と時刻・回の番号だけ。物件名・申込者名などは入れない。
 * - 通知の本文は種類と件数・時刻だけ(D4)。文言は段階2の画面内のポップアップと同じ関数を使う。
 */
import { nextActionReminderBody, registryJobBody, INQUIRY_URL, NEXT_ACTION_URL } from "@/lib/notifications/summary-state";
import { EDIT_LOCK_LOST_TITLE, editLockLostBody } from "@/lib/notifications/edit-lock-notice";

export const DELIVERY_KINDS = ["next_action", "inquiry_new", "registry_job_done", "edit_lock_lost"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const SOURCES = ["inquiry", "registry_job"] as const;
export type Source = (typeof SOURCES)[number];

/** 送信中のまま15分過ぎた行は、落ちた処理の残骸として取り直す(査定申込のメール通知と同じ)。 */
export const CLAIM_STALE_MS = 15 * 60 * 1000;
/** 送り直しは最大3回(初回を含めて3回まで)。 */
export const MAX_ATTEMPTS = 3;
/** 送り直しの間隔(続けて失敗した中継サービスをすぐ叩き直さない)。 */
export const RETRY_BACKOFF_MS = 10 * 60 * 1000;
/** 送り直すのは作ってから2時間まで(次回対応の次の回=最短2時間後まで・§7.2)。 */
export const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 中継サービスへの送信の時間制限。 */
export const SEND_TIMEOUT_MS = 10_000;
/**
 * 送信を包むトランザクションの時間制限。**送信の時間制限より必ず長く**する(設計書 §7.5。
 * Prisma の既定5秒のままだと、送れたのに sent への更新が巻き戻って15分後にもう一度送るため)。
 */
export const SEND_TX_TIMEOUT_MS = 20_000;
export const SEND_TX_MAX_WAIT_MS = 5_000;
/** 中継サービスに預ける時間(端末がつながっていない間)。古い件数を翌日に出さないよう短めにする。 */
export const PUSH_TTL_SECONDS = 2 * 60 * 60;
/** 送信の記録・見つけた出来事は30日で消す。 */
export const RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 1回の実行で新しい送信を始めてよい時間(実行の始めから)。残りは次の実行で送る。
 * 中継サービスが遅いと1通に最大20秒(送信のトランザクション)かかるので、timer の curl の
 * 時間制限(240秒)より十分短くし、実行が次の起動と重ならないようにする(@codex #472 P2)。
 */
export const SEND_RUN_BUDGET_MS = 150_000;
/** 1回の実行で送る上限(残りは次の実行で送る)。 */
export const SEND_BATCH_LIMIT = 200;

// ---------- ref_key ----------

/** 次回対応: next_action:<ID>:<期限Tのエポック秒>:<rev(エポックミリ秒)>:<回>(§7.2)。 */
export function nextActionRefKey(id: string, deadlineMs: number, revMs: number, slot: number): string {
  return `next_action:${id}:${Math.floor(deadlineMs / 1000)}:${revMs}:${slot}`;
}

export function parseNextActionRefKey(key: string): { id: string; deadlineSec: number; revMs: number; slot: number } | null {
  const m = /^next_action:([0-9a-f-]{36}):(\d+):(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  return { id: m[1], deadlineSec: Number(m[2]), revMs: Number(m[3]), slot: Number(m[4]) };
}

export function eventRefKey(source: Source, id: string): string {
  return `${source}:${id}`;
}

export function parseEventRefKey(source: Source, key: string): string | null {
  const m = new RegExp(`^${source}:([0-9a-f-]{36})$`).exec(key);
  return m ? m[1] : null;
}

/** 編集権限が外れた記録: edit_lock_loss:<記録ID>(段階4c・設計書 §7.2)。 */
export function editLockLossRefKey(eventId: string): string {
  return `edit_lock_loss:${eventId}`;
}

export function parseEditLockLossRefKey(key: string): string | null {
  const m = /^edit_lock_loss:([0-9a-f-]{36})$/.exec(key);
  return m ? m[1] : null;
}

/** 外れてから1時間を過ぎた記録は送らない(戻ったときに画面でも知らせる・設計書 §7.3)。 */
export const EDIT_LOCK_LOSS_NOTIFY_WINDOW_MS = 60 * 60 * 1000;

export function kindOfSource(source: Source): DeliveryKind {
  return source === "inquiry" ? "inquiry_new" : "registry_job_done";
}

// ---------- 本文(Service Worker に渡す形・public/sw.js の push と同じ名前) ----------

export interface PushPayload {
  /** 送ったときの結び付け。Service Worker は保存値と一致したときだけ中身を出す。 */
  b: string;
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function nextActionPayload(
  bindingId: string,
  fresh: Array<{ dueTime?: string }>,
  today: number,
  overdue: number,
): PushPayload {
  return {
    b: bindingId,
    title: "次回対応",
    body: nextActionReminderBody(fresh, today, overdue),
    url: NEXT_ACTION_URL,
    tag: "next-action:reminder",
  };
}

export function inquiryPayload(bindingId: string, count: number): PushPayload {
  return { b: bindingId, title: "査定の申込", body: `新しい査定の申込が${count}件あります`, url: INQUIRY_URL, tag: "inquiry:new" };
}

/**
 * `tagKey` は段階2の画面内の知らせと同じ不透明な値(seenKey)。画面を開いている間に両方から届いても、
 * 通知欄では同じ tag で1つに置き換わる(ジョブの ID を tag に出さない)。
 */
export function registryJobPayload(
  bindingId: string,
  jobId: string,
  tagKey: string,
  counts: { done: number; failed: number; skipped: number; chargedButFailed: number },
): PushPayload {
  return {
    b: bindingId,
    title: "謄本の一括取得",
    body: registryJobBody(counts),
    url: `/properties/registry-fetch/${jobId}`,
    tag: `registry-job:${tagKey}`,
  };
}

/**
 * 編集権限が外れた(N2)。tag は段階1の画面からの知らせと同じ(両方から届いても通知欄で1つに置き換わる)。
 * 開く画面: 物件はその物件の画面。所有者は物件の画面の中で編集するので、どの物件かはサーバーで決めず
 * ホームへ(URL に入れるのは ID だけ)。「保存されていない入力があります」は画面にしか分からないので付けない。
 */
export function editLockLostPayload(
  bindingId: string,
  e: { resourceType: "property" | "owner"; resourceId: string; cause: "heartbeat" | "idle" | "force_released" },
): PushPayload {
  return {
    b: bindingId,
    title: EDIT_LOCK_LOST_TITLE,
    body: editLockLostBody(e.cause === "force_released" ? "force_released" : "expired"),
    url: e.resourceType === "property" ? `/properties/${e.resourceId}` : NEXT_ACTION_URL,
    tag: `edit-lock:lost:${e.resourceType}:${e.resourceId}`,
  };
}

// ---------- 送信結果の分け方 ----------

export type SendOutcome = { ok: true } | { ok: false; gone: boolean; code: string };

/** 中継サービスの応答を定型コードに分ける(本文・URL は残さない)。404/410 は宛先が無効(gone)。 */
export function classifySendError(e: unknown): { gone: boolean; code: string } {
  const status = (e as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number") {
    if (status === 404 || status === 410) return { gone: true, code: `http_${status}` };
    if (status >= 100 && status <= 599) return { gone: false, code: `http_${status}` };
  }
  const code = (e as { code?: unknown } | null)?.code;
  const message = (e as { message?: unknown } | null)?.message;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ECONNRESET" || message === "Socket timeout" || message === "push_timeout") {
    return { gone: false, code: "timeout" };
  }
  return { gone: false, code: "network" };
}
