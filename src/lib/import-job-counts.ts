import prisma from "@/lib/prisma";
import type { ImportRowStatus } from "@/generated/prisma";

/**
 * 取込ジョブの集計列（successCount / errorCount）と完了ステータスを、
 * 現在の ImportJobRow.status から再計算して ImportJob に反映する。
 *
 * 行解決（PATCH …/rows/[rowId]）と retry（POST …/rows/[rowId]/retry）の双方から
 * 呼ばれる共有ヘルパ。以前は両ルートに同一関数が重複しており、いずれも全行を
 * findMany してから JS で status ごとに filter していた。行数の多いジョブで解決の
 * たびに全行を読み込む負荷を避けるため、status 単位の groupBy 集約に置き換える。
 *
 * 集計の意味づけは従来実装と完全一致させる:
 *   - successCount       … status === "success" の行数
 *   - errorCount(保存値) … error + needs_review の行数（既存スキーマの混在仕様を踏襲）
 *   - 未解決(error / needs_review / pending)が無くなったら status="completed" / completedAt をセット
 *
 * pending を未解決に含める理由: 手動添付（登記DM取込の一括PDF添付など）を伴う
 * ジョブ種別では、行が resume 待ちの pending のまま残ることがある。PATCH（行解決）
 * や retry はこの共有ヘルパーを呼ぶため、pending 行を無視すると「最後の
 * needs_review 行を skip/mark_error で処理した瞬間、pending 行が残っていても
 * ジョブが completed になってしまう」非対称が生じる（手動添付ルート側は
 * pendingRows を考慮済みだった）。既存のジョブ種別（受付帳CSV等）は pending 行を
 * 持たないため、この変更で挙動は変わらない。
 */
export async function recalculateJobCounts(jobId: string): Promise<void> {
  const grouped = await prisma.importJobRow.groupBy({
    by: ["status"],
    where: { jobId },
    _count: { _all: true },
  });

  // groupBy は該当 0 件の status を行として返さないため、必ず 0 埋めする。
  const countOf = (status: ImportRowStatus): number =>
    grouped.find((g) => g.status === status)?._count._all ?? 0;

  const successCount = countOf("success");
  const errorCount = countOf("error");
  const needsReviewCount = countOf("needs_review");
  const pendingCount = countOf("pending");

  const hasUnresolved = errorCount > 0 || needsReviewCount > 0 || pendingCount > 0;

  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      successCount,
      errorCount: errorCount + needsReviewCount,
      ...(hasUnresolved ? {} : { status: "completed", completedAt: new Date() }),
    },
  });
}
