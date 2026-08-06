/**
 * 謄本 一括取得(PR-B・薄い版)の型と分類。
 *
 * 設計=docs/registry-bulk-fetch-design.md。薄い版の要点:
 *  - 1件ごとの処理は既存の単発取得(runRegistryAutoFetch)を**そのまま呼ぶ**。
 *    課金の安全(二重課金ガード=AuditLog・charged_but_failed・添付必須)は単発から継承する。
 *  - status/certificate_type は TEXT + ここの allowlist で縛る(新 enum を作らない)。
 *  - ⚠この層は provider を呼ばない純ロジック(分類・件数計算)を持ち、テストしやすくする。
 */
import { ApiError } from "@/lib/api-helpers";
import { RegistryFetchError } from "@/lib/registry-fetch";

/** ジョブの状態。 */
export const JOB_STATUSES = [
  "pending",
  "processing",
  "paused",
  "completed",
  "cancelled",
] as const;
export type BulkJobStatus = (typeof JOB_STATUSES)[number];

/** 項目の状態。 */
export const ITEM_STATUSES = [
  "pending",
  "processing",
  "done",
  "failed",
  "skipped",
  "charged_but_failed",
] as const;
export type BulkItemStatus = (typeof ITEM_STATUSES)[number];

/** 終了扱い(これ以上 pending に戻さない)の項目状態。 */
export const TERMINAL_ITEM_STATUSES: readonly BulkItemStatus[] = [
  "done",
  "failed",
  "skipped",
  "charged_but_failed",
];

/** 1ジョブの項目数上限(超過は分割案内)。 */
export const MAX_BULK_ITEMS = 50;

/**
 * 1件処理の結果分類。process 層が単発取得の成功/例外をこの形へ畳み、
 * DB 更新(項目 status・件数・ジョブ paused 判定)を決める。
 */
export interface ItemOutcome {
  /** 項目に確定させる終了状態。rate_limited/cancelled は例外的に別扱い(下記)。 */
  status: BulkItemStatus;
  /** 非PIIの分類コード(provider 分類 or ApiError code)。所在・地番・所有者名は載せない。 */
  errorCode: string | null;
  /**
   * この結果でジョブ全体を **paused** にすべきか。
   * charged_but_failed(課金済みなのに失敗=お金が動いた・要人手)と、
   * 課金スイッチが実行中に落ちた(readiness 崩れ)場合のみ true。
   */
  pauseJob: boolean;
  /**
   * 掴んだ項目を消費せず **pending のまま残す**(件数に数えない)べきか。
   * rate_limited(まだ順番待ち)・cancelled(ジョブ中止)で true。
   * 画面はこの結果を見て「間隔を空けて再試行」or「中止確定」する。
   */
  leavePending: boolean;
  /** 中止(cancelled)由来か。画面/呼び出し側が停止を確定するために使う。 */
  cancelled: boolean;
}

/**
 * provider 由来の安全分類コードから項目結果を決める(RegistryFetchError.code と
 * ApiError.providerCode の両方で使う)。
 *
 * ⚠**課金済みの失敗(charged_but_failed)は必ず paused**。お金が動いた可能性がある項目を
 * 黙って次へ流さない(利用者にマイページ確認を促す)。
 * ⚠**rate_limited は pending のまま**(件数に数えない=画面が間隔を空けて再試行)。
 */
function classifyByProviderCode(code: string): ItemOutcome {
  const base = { pauseJob: false, leavePending: false, cancelled: false };
  switch (code) {
    case "charged_but_failed":
      return { status: "charged_but_failed", errorCode: code, pauseJob: true, leavePending: false, cancelled: false };
    case "rate_limited":
      return { status: "pending", errorCode: code, pauseJob: false, leavePending: true, cancelled: false };
    case "cancelled":
      return { status: "pending", errorCode: code, pauseJob: false, leavePending: true, cancelled: true };
    // 要手動(自動では拾えない)=skipped。次の項目へ進む。
    case "not_found":
    case "location_rejected":
      return { status: "skipped", errorCode: code, ...base };
    // 一時的な失敗(あとで再試行可能)=failed。次の項目へ進む。
    case "timeout":
    case "provider_error":
    case "auth_failed":
    case "service_hours":
    case "service_unavailable":
      return { status: "failed", errorCode: code, ...base };
    default:
      return { status: "failed", errorCode: code, ...base };
  }
}

/**
 * 単発取得(runRegistryAutoFetch / runRegistrySearch / resolveRegistryCandidate)が
 * 投げた例外を、一括の項目結果へ分類する純関数。
 *
 * ⚠**最重要(@codex #361 P1)**: runRegistryAutoFetch/runRegistrySearch は
 * RegistryFetchError を **ApiError に包んで** throw する(元コードは providerCode に載る)。
 * このため charged_but_failed/rate_limited は `instanceof RegistryFetchError` では拾えない。
 * **providerCode を最優先で見て**分類する(見落とすと課金済み失敗が failed 扱いになり次の
 * 有料項目へ進んでしまう)。
 * ⚠**既取得(ALREADY_DONE)は done にしない**。台帳の鍵は charged と charged_but_failed の
 * 両方で立ち、registryStatus も物件全体で別種の取得で obtained になり得るため、鍵の存在は
 * 「この請求で PDF が付いた」証明にならない。安全側=skipped(要確認)にする。
 */
export function classifyItemError(err: unknown): ItemOutcome {
  const base = { pauseJob: false, leavePending: false, cancelled: false };

  // 生の RegistryFetchError(直接呼び出し等)。
  if (err instanceof RegistryFetchError) {
    return classifyByProviderCode(err.code);
  }

  // route/lib の入力・認可・状態エラー(ApiError)。
  if (err instanceof ApiError) {
    // ⚠provider 分類が包まれている場合は元コードで判定(charged_but_failed→paused 等)。
    if (err.providerCode) {
      return classifyByProviderCode(err.providerCode);
    }
    // 既取得は done にしない=安全側 skipped(要確認)。
    if (err.code === "REGISTRY_PURCHASE_ALREADY_DONE") {
      return { status: "skipped", errorCode: "already_processed_manual_check", ...base };
    }
    // 課金スイッチが実行中に落ちた=readiness 崩れ。ジョブを止めて人手に委ねる。
    if (err.code === "REGISTRY_PURCHASE_NOT_ENABLED" || err.status === 501) {
      return { status: "pending", errorCode: err.code, pauseJob: true, leavePending: true, cancelled: false };
    }
    // 物件が変わった/候補が合わない/施錠競合(409)・アクセス喪失(403)= 要手動 skipped。
    if (err.status === 409 || err.status === 403 || err.status === 404 || err.status === 422) {
      return { status: "skipped", errorCode: err.code ?? String(err.status), ...base };
    }
    return { status: "failed", errorCode: err.code ?? String(err.status), ...base };
  }

  // 想定外(Prisma 等)= failed。次の項目へ進む(ジョブは止めない)。
  return { status: "failed", errorCode: "unexpected", ...base };
}

/** 値が許可された項目状態か。 */
export function isBulkItemStatus(v: string): v is BulkItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(v);
}

/** 値が許可されたジョブ状態か。 */
export function isBulkJobStatus(v: string): v is BulkJobStatus {
  return (JOB_STATUSES as readonly string[]).includes(v);
}
