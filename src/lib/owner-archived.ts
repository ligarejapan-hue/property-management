// アーカイブ済みの所有者を戻す(2026-11-24 発注者「作る」)。画面とサーバーで共有する決まり。

/** なぜ隠れているか。統合で隠れた(merged)か、孤立のアーカイブで隠した(archived)か。 */
export type ArchiveOrigin = "merged" | "archived";

export const ARCHIVE_ORIGIN_LABEL: Record<ArchiveOrigin, string> = {
  merged: "統合で隠れた",
  archived: "アーカイブした",
};

/**
 * 履歴の日時で決める。統合は同じ取引で isArchived の履歴も書く(now() が同じ)ので、
 * 統合の記録が最後のアーカイブ以後なら「統合」。統合のあと改めてアーカイブされていれば「アーカイブ」。
 */
export function classifyArchiveOrigin(input: {
  lastArchivedAt: Date | null;
  lastMergedAt: Date | null;
}): ArchiveOrigin {
  if (!input.lastMergedAt) return "archived";
  if (!input.lastArchivedAt) return "merged";
  return input.lastMergedAt.getTime() >= input.lastArchivedAt.getTime()
    ? "merged"
    : "archived";
}

export interface ArchivedOwnerRow {
  ownerId: string;
  ownerNameMasked: string | null;
  addressMasked: string | null;
  version: number;
  origin: ArchiveOrigin;
  /** 統合で隠れた人の統合先(戻しても物件・メモは統合先に残る)。 */
  mergedInto: { ownerId: string; ownerNameMasked: string | null; isArchived: boolean } | null;
  /** 隠した日時(ISO)。古いデータで履歴が無ければ null。 */
  archivedAt: string | null;
  detailUrl: string;
}

export interface ArchivedOwnersResponse {
  rows: ArchivedOwnerRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const ARCHIVED_PAGE_SIZE = 50;
