// 法人番号「一括反映」UI 用の純関数ヘルパー（DB / I/O / React 非依存）。
//
// 設計上の不変条件:
// - 一括反映の対象は type==="missing"（既存 corporateNumber が空・単一検出）の行のみ。
//   conflict / multi / same は手動確認に回す（このヘルパーでは対象外）。
// - クライアントから送るのは {ownerId, version} のみ（法人番号生値・氏名・住所は送らない）。
//   実際の検出・国税庁 lookup・廃止判定はすべて server route が再実行する（client は信頼境界外）。
// - 上限 50 件 / バッチ（server route の MAX_BULK と一致させる）。
import type {
  BulkCorporateApplyStatus,
  CorporateCandidateRowDTO,
} from "./api-client";

/** 1 バッチで送れる最大件数。server route 側 MAX_BULK と一致させること。 */
export const MAX_CORPORATE_BULK = 50;

/** 一括反映の対象になり得る行か（missing = 既存値なし・単一検出のみ）。 */
export function isBulkEligible(
  row: Pick<CorporateCandidateRowDTO, "type">,
): boolean {
  return row.type === "missing";
}

/** rows のうち一括反映対象（missing）の ownerId 一覧。 */
export function eligibleOwnerIds(rows: CorporateCandidateRowDTO[]): string[] {
  return rows.filter(isBulkEligible).map((r) => r.ownerId);
}

/** 送信可能な選択件数か（1 以上・上限以下）。 */
export function canSubmitBulk(selectedCount: number): boolean {
  return selectedCount >= 1 && selectedCount <= MAX_CORPORATE_BULK;
}

/**
 * 選択 ownerId と現在表示中の rows から送信ペイロード {ownerId, version} を作る。
 * - eligible(missing) かつ選択済みの行のみ
 * - 表示順を保ったまま最大 MAX_CORPORATE_BULK 件で打ち切る（保険。UI でも cap する）
 * version は楽観ロック用。stale でも server 側で version_conflict として安全に skip される。
 */
export function buildBulkPayload(
  rows: CorporateCandidateRowDTO[],
  selectedIds: ReadonlySet<string>,
): Array<{ ownerId: string; version: number }> {
  return rows
    .filter((r) => isBulkEligible(r) && selectedIds.has(r.ownerId))
    .slice(0, MAX_CORPORATE_BULK)
    .map((r) => ({ ownerId: r.ownerId, version: r.version }));
}

/** 結果ステータスの日本語ラベル（PII 非依存・件数集計の表示用）。 */
export const BULK_STATUS_LABEL: Record<BulkCorporateApplyStatus, string> = {
  applied: "反映",
  already_set: "既に設定済み",
  not_found: "対象なし（削除/アーカイブ）",
  version_conflict: "競合（再読込が必要）",
  no_single_detection: "検出が単一でない",
  lookup_no_result: "国税庁に該当なし",
  closed: "廃止法人のため除外",
  lookup_error: "lookup エラー",
  not_processed: "未処理（時間切れ・再実行してください）",
};

export interface BulkResultSummary {
  /** 反映できた件数 */
  applied: number;
  /** 反映されずスキップされた件数（applied 以外すべて） */
  skipped: number;
  /** ステータス別件数（0 件のものは含めない） */
  byStatus: Array<{ status: BulkCorporateApplyStatus; count: number }>;
}

/** 結果配列を集計する。順序は applied を先頭に、残りは件数降順→ステータス名昇順で安定化。 */
export function summarizeBulkResults(
  results: Array<{ status: BulkCorporateApplyStatus }>,
): BulkResultSummary {
  const counts = new Map<BulkCorporateApplyStatus, number>();
  for (const r of results) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  }
  const applied = counts.get("applied") ?? 0;
  const byStatus = Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => {
      if (a.status === "applied") return -1;
      if (b.status === "applied") return 1;
      if (b.count !== a.count) return b.count - a.count;
      return a.status < b.status ? -1 : a.status > b.status ? 1 : 0;
    });
  return { applied, skipped: results.length - applied, byStatus };
}
