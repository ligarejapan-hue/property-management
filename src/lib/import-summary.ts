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
  // pending（registry_pdf_bulk 由来の「未処理」行）も型として受け取れるように
  // する。calcImportSummary の switch は pending 用の分岐で明示的に無視する
  // （5区分の集計対象外・totalCount にも含めない）ので挙動は変わらない。
  status: "success" | "error" | "skipped" | "needs_review" | "pending";
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
      // pending（registry_pdf_bulk 由来の「未処理」行）は意図的に集計対象外
      // （5区分・totalCount のいずれにも含めない。summaryFromStatusCounts と同じ方針）。
      case "pending":
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

/**
 * status 別件数のマップ。ImportRowStatus（success / error / skipped /
 * needs_review / pending）と一致するキーを持つ。Prisma 依存を避けるため enum を
 * import せず、リテラルキーの optional interface として定義する。
 *
 * groupBy は該当 0 件の status を行として返さないため、未指定キーは
 * `undefined`（= 0 件）として扱う。
 *
 * pending（registry_pdf_bulk 由来の「未処理」行）はキーとして受け取れるように
 * するが、summaryFromStatusCounts の 5 区分（新規/更新/スキップ/要レビュー/
 * エラー）はいずれも完了済みステータスのみを対象にしており、pending は意図的に
 * 集計対象外（totalCount にも含めない）とする。ImportSummary の形状・意味は
 * 変えない。
 */
export interface StatusCounts {
  success?: number;
  error?: number;
  skipped?: number;
  needs_review?: number;
  pending?: number;
}

/**
 * 一覧画面向けサマリ算出。全行を取得して JS で集計する calcImportSummary とは
 * 異なり、DB 側の groupBy 集約結果（status 別件数 + 更新件数）から ImportSummary
 * を組み立てる。返す形は calcImportSummary と完全一致する。
 *
 * @param counts        ① groupBy(by:["jobId","status"]) 由来の status 別件数。
 *                      未指定 status は 0 件として扱う。
 * @param updatedCount  ② groupBy(by:["jobId"], where:{status:"success",
 *                      errorMessage:{startsWith:"更新"}}) 由来の「更新」success 件数。
 *
 * createdCount は successTotal − updatedCount で導出する。updatedCount は定義上
 * success の部分集合（success かつ errorMessage が「更新」始まり）なので
 * updatedCount <= successTotal が常に成り立つが、2 本の groupBy がわずかに
 * 異なるスナップショットを見る競合に備え、createdCount が負にならないよう
 * updatedCount を [0, successTotal] にクランプする。
 */
export function summaryFromStatusCounts(
  counts: StatusCounts,
  updatedCount: number,
): ImportSummary {
  const successTotal = counts.success ?? 0;
  const skippedCount = counts.skipped ?? 0;
  const needsReviewCount = counts.needs_review ?? 0;
  const errorCount = counts.error ?? 0;

  const safeUpdated = Math.min(Math.max(updatedCount, 0), successTotal);
  const createdCount = successTotal - safeUpdated;

  return {
    createdCount,
    updatedCount: safeUpdated,
    skippedCount,
    needsReviewCount,
    errorCount,
    totalCount:
      createdCount +
      safeUpdated +
      skippedCount +
      needsReviewCount +
      errorCount,
  };
}
