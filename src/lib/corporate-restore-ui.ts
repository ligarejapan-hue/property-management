// 「法人番号復元」タブ(一括復元)UI 用の純関数ヘルパー(DB / I/O / React 非依存)。
//
// 設計上の不変条件(corporate-bulk-ui.ts と同型):
// - 一括復元の対象は eligible=true の行のみ(分断型=12桁復元済 / 断片型=会社名救出可)。
//   eligible=false(氏名がラベルのみ等)は手動対応に回す。
// - クライアントから送るのは {ownerId, version} + addressMode のみ
//   (復元番号・氏名・住所の生値は送らない。検出・lookup は server が再実行する)。
// - 上限 50 件 / バッチ(server route の MAX_BULK と一致させる)。
import type {
  CorporateRestoreApplyStatus,
  CorporateRestoreRowDTO,
  SplitCorporateTypeDTO,
} from "./api-client";

/** 1 バッチで送れる最大件数。server route 側 MAX_BULK と一致させること。 */
export const MAX_CORPORATE_RESTORE = 50;

/** 種別の日本語ラベル(表・バッジ表示用)。 */
export const RESTORE_TYPE_LABEL: Record<SplitCorporateTypeDTO, string> = {
  address_name_split: "番号が住所と氏名に分断",
  name_fragment: "氏名に番号の断片",
  number_set_name_lost: "番号はあるが会社名が数字のまま",
};

/** 一括復元の対象になり得る行か。 */
export function isRestoreEligible(
  row: Pick<CorporateRestoreRowDTO, "eligible">,
): boolean {
  return row.eligible;
}

/** rows のうち一括復元対象の ownerId 一覧。 */
export function eligibleRestoreIds(rows: CorporateRestoreRowDTO[]): string[] {
  return rows.filter(isRestoreEligible).map((r) => r.ownerId);
}

/** 送信可能な選択件数か(1 以上・上限以下)。 */
export function canSubmitRestore(selectedCount: number): boolean {
  return selectedCount >= 1 && selectedCount <= MAX_CORPORATE_RESTORE;
}

/**
 * 選択 ownerId と現在表示中の rows から送信ペイロード {ownerId, version} を作る。
 * - eligible かつ選択済みの行のみ
 * - 表示順を保ったまま最大 MAX_CORPORATE_RESTORE 件で打ち切る(保険。UI でも cap する)
 * version は楽観ロック用。stale でも server 側で version_conflict として安全に skip される。
 */
export function buildRestorePayload(
  rows: CorporateRestoreRowDTO[],
  selectedIds: ReadonlySet<string>,
): Array<{ ownerId: string; version: number }> {
  return rows
    .filter((r) => isRestoreEligible(r) && selectedIds.has(r.ownerId))
    .slice(0, MAX_CORPORATE_RESTORE)
    .map((r) => ({ ownerId: r.ownerId, version: r.version }));
}

/** 結果ステータスの日本語ラベル(平易な表現・PII 非依存)。 */
export const RESTORE_STATUS_LABEL: Record<CorporateRestoreApplyStatus, string> = {
  applied: "復元しました",
  not_found: "所有者が見つかりません(削除済みの可能性)",
  version_conflict: "他の更新と重なりました(再読み込みしてください)",
  no_detection: "対象の壊れ方ではなくなっています",
  not_eligible: "自動復元できません(手動で確認してください)",
  lookup_no_result: "国税庁に該当する法人がありません",
  closed: "廃止された法人のため反映しません",
  lookup_error: "国税庁への照会に失敗しました(時間をおいて再実行)",
  not_processed: "時間切れで未処理(もう一度実行してください)",
};

export interface RestoreResultSummary {
  applied: number;
  skipped: number;
  byStatus: Array<{ status: CorporateRestoreApplyStatus; count: number }>;
}

/** 結果配列を集計する。applied を先頭に、残りは件数降順→ステータス名昇順で安定化。 */
export function summarizeRestoreResults(
  results: Array<{ status: CorporateRestoreApplyStatus }>,
): RestoreResultSummary {
  const counts = new Map<CorporateRestoreApplyStatus, number>();
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
