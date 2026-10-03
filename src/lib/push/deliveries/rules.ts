/**
 * 通知 段階4b(Web プッシュの送信)の決まりごと。**純関数と定数だけ**(設計書 §7.2〜§7.5)。
 *
 * - ref_key(1通に含めた件の印)は ID と時刻・回の番号だけ。物件名・申込者名などは入れない。
 * - 通知の本文は種類と件数・時刻だけ(D4)。文言は段階2の画面内のポップアップと同じ関数を使う。
 */
import { nextActionReminderBody, registryJobBody, INQUIRY_URL, NEXT_ACTION_URL } from "@/lib/notifications/summary-state";

export const DELIVERY_KINDS = ["next_action", "inquiry_new", "registry_job_done"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const SOURCES = ["inquiry", "registry_job"] as const;
export type Source = (typeof SOURCES)[number];

/** 送信中のまま15分過ぎた行は、落ちた処理の残骸として取り直す(査定申込のメール通知と同じ)。 */
export const CLAIM_STALE_MS = 15 * 60 * 1000;
/** 送り直しは最大3回(初回を含めて3回まで)。 */
export const MAX_ATTEMPTS = 3;
/** 送り直しの間隔(続けて失敗した中継サービスをすぐ叩き直さない)。 */
export const RETRY_BACKOFF_MS = 10 * 60 * 1000;
/**
 * 送り直すのは作ってから12時間まで(次回対応の回の間隔の最大=12時間・§7.2)。次回対応は「その回の次の
 * 予定時刻まで」送り直す決まりで、回が進んだら送る直前の確かめ直しで外れるので、間隔の長い回(6時間・
 * 12時間ごと)でも次の回までは送り直せる(@codex #472 P2)。編集権限の知らせは別に1時間で締める。
 */
export const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;
/** 中継サービスへの送信の時間制限。 */
export const SEND_TIMEOUT_MS = 10_000;
/**
 * 送信を包むトランザクションの時間制限。**送信の時間制限より必ず長く**する(設計書 §7.5。
 * Prisma の既定5秒のままだと、送れたのに sent への更新が巻き戻って15分後にもう一度送るため)。
 */
export const SEND_TX_TIMEOUT_MS = 20_000;
/**
 * 送信のあとの書き込み(sent 等)に残しておく時間。送る前の処理(取り合い・確かめ直し)が
 * 「トランザクションの時間 − 送信の時間 − これ」を超えていたら、その回は送らずに巻き戻す
 * (遅く送り始めて、届いたのに結果が書けず巻き戻る=次の実行でもう一度送る、を防ぐ・@codex #472 P2)。
 */
export const SEND_FINALIZE_RESERVE_MS = 4_000;
export const SEND_PRESEND_LIMIT_MS = SEND_TX_TIMEOUT_MS - SEND_TIMEOUT_MS - SEND_FINALIZE_RESERVE_MS;
/**
 * 申込・謄本ジョブの記録づくりは、1つのトランザクションで新しく見つけた出来事を100件まで
 * (残りは続けて次のトランザクションで・@codex #472 P2)。トランザクションの時間制限は30秒。
 */
export const SOURCE_EVENTS_PER_TX = 100;
/**
 * 1トランザクションで作る「件×端末」の上限。送り先の端末が多いときは1回分の出来事の件数を減らす
 * (端末ごとの記録づくりでトランザクションが時間切れになり、同じ所でやり直し続けない・@codex #472 P2)。
 */
export const SOURCE_REFS_PER_TX = 2000;

/** 1トランザクションで扱う出来事の件数(送り先の端末の数に合わせて1〜100件)。 */
export function sourceEventsPerTx(subscriptionCount: number): number {
  return Math.max(1, Math.min(SOURCE_EVENTS_PER_TX, Math.floor(SOURCE_REFS_PER_TX / Math.max(1, subscriptionCount))));
}

/**
 * 始める位置を k だけずらす。呼び出し側は実行ごとに乱数で k を決める(実行の間隔や時刻の刻みに
 * よらず、毎回同じ先頭からで後ろが溢れ続けることがない・@codex #472 P2)。
 */
export function rotateStart<T>(items: T[], k: number): T[] {
  if (items.length === 0) return items;
  const i = ((k % items.length) + items.length) % items.length;
  return [...items.slice(i), ...items.slice(0, i)];
}
/**
 * 申込・謄本ジョブの記録づくりに使ってよいのは、1回分の持ち時間のうち始めから90秒まで
 * (2つを交互に1回分ずつ進める=片方の溜まりでもう片方や次回対応を止めない・@codex #472 P2)。
 */
export const SOURCE_PLAN_BUDGET_MS = 90_000;
/** 次回対応の記録づくりは始めから120秒まで(残りの30秒以上を送信に残す・@codex #472 P2)。 */
export const NEXT_ACTION_PLAN_BUDGET_MS = 120_000;
export const SOURCE_PLAN_TX_TIMEOUT_MS = 30_000;
/** 古い記録の片付けは1回に1,000件まで(残りは次の実行で)。 */
export const PURGE_BATCH = 1000;
export const SEND_TX_MAX_WAIT_MS = 5_000;
/** 中継サービスに預ける時間(端末がつながっていない間)。古い件数を翌日に出さないよう短めにする。 */
export const PUSH_TTL_SECONDS = 2 * 60 * 60;
/** 送信の記録・見つけた出来事は30日で消す。 */
export const RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 1回の実行の持ち時間(実行の始めから)。これを過ぎたら、記録づくり・送信とも新しい処理は始めない
 * (残りは次の実行で)。1つの処理は最大20秒(トランザクションの時間制限)なので、timer の curl の
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
