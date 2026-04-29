/**
 * 取込ジョブ行の集計ヘルパ。
 *
 * 既存スキーマ (ImportJob.successCount / errorCount) は
 *   - successCount に「新規 + 更新」が混在
 *   - errorCount に「純エラー + 要レビュー」が混在
 * していて、現場が欲しい 5 区分 (新規 / 更新 / スキップ / 要レビュー / エラー)
 * を直接表現できない。
 *
 * 段階A (migration なし) では DB を変えずに ImportJobRow から動的に
 * 5 区分を計算してUIで表示する。本ファイルはその計算を行 / 一覧 / 詳細
 * の各画面で同じロジックを使えるよう一箇所に集約したもの。
 *
 * 「新規 vs 更新」の判別は ImportJobRow.errorMessage が「更新」で始まる
 * 既存規約 (isUpdateMessage) を流用する。これは段階Bで actionType カラムを
 * 追加する際に置き換える前提だが、今は文字列パターンのみで判定する。
 */

import { isUpdateMessage } from "./import-row-display";

export interface ImportRowLike {
  status: "success" | "error" | "skipped" | "needs_review";
  errorMessage: string | null;
}

export interface ImportSummary {
  /** 新規作成 (success かつ errorMessage が「更新」プレフィックス無し) */
  createdCount: number;
  /** 既存レコード更新 (success かつ errorMessage が「更新...」) */
  updatedCount: number;
  /** スキップ (status === "skipped") */
  skippedCount: number;
  /** 要レビュー (status === "needs_review") */
  needsReviewCount: number;
  /** 純エラー (status === "error") */
  errorCount: number;
  /** 集計対象の総行数 (= 上記5項目の合計) */
  totalCount: number;
}

/**
 * ImportJobRow[] を 5 区分にカテゴリ分けして件数を返す。
 * row が空でも全項目 0 を返すので、呼び出し側で undefined ケアは不要。
 */
export function calcImportSummary(rows: ImportRowLike[]): ImportSummary {
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let needsReviewCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    switch (row.status) {
      case "success":
        if (isUpdateMessage(row.errorMessage)) {
          updatedCount++;
        } else {
          createdCount++;
        }
        break;
      case "skipped":
        skippedCount++;
        break;
      case "needs_review":
        needsReviewCount++;
        break;
      case "error":
        errorCount++;
        break;
      // unknown status は集計対象外（段階Bで actionType を追加した際の
      // 旧データ互換も含めて、サイレントに無視するのが安全）
      default:
        break;
    }
  }

  return {
    createdCount,
    updatedCount,
    skippedCount,
    needsReviewCount,
    errorCount,
    totalCount:
      createdCount + updatedCount + skippedCount + needsReviewCount + errorCount,
  };
}
