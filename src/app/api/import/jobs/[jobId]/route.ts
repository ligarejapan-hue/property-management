import { NextRequest } from "next/server";
import { Prisma, type ImportRowStatus } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import {
  summaryFromStatusCounts,
  type StatusCounts,
} from "@/lib/import-summary";
import { isReceptionOwnerJobRow } from "@/lib/reception-owner-link";

// ---------- GET /api/import/jobs/:jobId ----------
//
// rows サーバーサイドページング(PR-B / B1):
//   query:
//     page   : 1始まり（省略可）
//     limit  : 1〜MAX_ROW_LIMIT（省略可）
//     status : success | error | skipped | needs_review（省略/不正は無視＝全status）
//   - page / limit のいずれも無ければ **rows 全件返却（従来挙動・後方互換）**。
//     いずれか指定時のみ skip/take でページ分だけ返す。
//   - status 指定時は rows の where に反映（その status だけページング）。
//   - summary は **ジョブ全体**（status フィルタ非依存）の 5 区分集計を維持。
//   - pagination メタ（page/limit/totalRows/totalPages/hasNextPage/hasPrevPage/status）を additive に返す。
//     totalRows は「現在の status フィルタ後の総行数」（= ページングの母数）。
//   - isReceptionOwnerJob / duplicateCount / duplicateActionableCount を additive に返し、
//     client がページ分の rows を走査して誤判定/誤集計しないで済むようにする。
//     duplicateActionableCount(B4) は bulk-resolve scope="duplicate" の対象件数と一致。
//   - レスポンス root の rows は維持し、{ data: ... } 形状変更はしない。

const VALID_ROW_STATUSES = [
  "success",
  "error",
  "skipped",
  "needs_review",
] as const;

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 100;

/**
 * query 文字列を **安全な正の整数** に正規化する。
 * - 小数は切り捨て（Math.floor）
 * - NaN / Infinity / -Infinity / 数値でない文字列 / 0 以下 → fallback
 * 返り値は常に整数（fallback も整数を渡す前提）。
 *
 * Prisma の skip/take は小数を受け付けず実行時エラーになるため、
 * `page=1.5` のような入力でも skip/take が必ず整数になるようにする（Codex #101 P2）。
 */
function toPositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback; // NaN / Infinity / -Infinity
  const floored = Math.floor(n);
  return floored >= 1 ? floored : fallback; // 0 / 負数 → fallback
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // ---- query parse ----
    const url = new URL(request.url);
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");
    const statusParam = url.searchParams.get("status");

    // 不正な status は無視（全 status 扱い）。
    const status: ImportRowStatus | null =
      statusParam &&
      (VALID_ROW_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as ImportRowStatus)
        : null;

    // page / limit のいずれかが来たときだけページング。来なければ全件（後方互換）。
    // skip/take に渡る値は必ず安全な整数にする（小数/負数/0/NaN/Infinity/不正文字列対策）。
    const paginate = pageParam !== null || limitParam !== null;
    const limit = paginate
      ? Math.min(MAX_ROW_LIMIT, toPositiveInt(limitParam, DEFAULT_ROW_LIMIT))
      : null;
    const page = paginate ? toPositiveInt(pageParam, 1) : 1;

    // ページングの母数は「現在の status フィルタ後」の行集合。
    const rowWhere: Prisma.ImportJobRowWhereInput = {
      jobId,
      ...(status ? { status } : {}),
    };

    // summary は **ジョブ全体**（status 非依存）で算出する（PR-A から維持）:
    //   ① groupBy(by:["status"]) で status 別件数
    //   ② groupBy(by:["jobId"]) で「更新」success 件数
    //      （success かつ errorMessage が「更新」始まり = isUpdateMessage 規約）
    // duplicateCount は「重複」由来の要レビュー/スキップ件数（ジョブ全体・additive・定義不変）。
    // duplicateActionableCount(B4 Codex P2) は bulk-resolve scope="duplicate" が実際に更新する
    // 集合（needs_review のみ・「重複」始まり）と完全一致する件数（additive）。
    // rows は status フィルタ後・指定ページ分のみ skip/take で取得する。
    // 存在しない jobId 系クエリは空/0 を返すだけで、404 は下で送出する。
    const [
      job,
      rows,
      statusGroups,
      updatedGroups,
      filteredTotal,
      duplicateCount,
      duplicateActionableCount,
    ] = await Promise.all([
      prisma.importJob.findUnique({
        where: { id: jobId },
        include: { executor: { select: { id: true, name: true } } },
      }),
      prisma.importJobRow.findMany({
        where: rowWhere,
        orderBy: { rowNumber: "asc" },
        ...(limit !== null ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      prisma.importJobRow.groupBy({
        by: ["status"],
        where: { jobId },
        _count: { _all: true },
      }),
      prisma.importJobRow.groupBy({
        by: ["jobId"],
        where: {
          jobId,
          status: "success",
          // null は startsWith にマッチしないため更新扱いされない。
          errorMessage: { startsWith: "更新" },
        },
        _count: { _all: true },
      }),
      prisma.importJobRow.count({ where: rowWhere }),
      // duplicateCount（既存・表示/互換用・定義不変）: needs_review + skipped × 「重複」始まり。
      prisma.importJobRow.count({
        where: {
          jobId,
          status: { in: ["needs_review", "skipped"] },
          errorMessage: { startsWith: "重複" },
        },
      }),
      // duplicateActionableCount（B4 Codex P2）: bulk-resolve scope="duplicate" の where と
      // 完全一致＝needs_review のみ × 「重複」始まり。skipped 済み重複は含めない。
      prisma.importJobRow.count({
        where: {
          jobId,
          status: "needs_review",
          errorMessage: { startsWith: "重複" },
        },
      }),
    ]);

    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    // groupBy は 0 件 status を返さないため未指定キーは 0 埋め扱いになる。
    const statusCounts: StatusCounts = {};
    for (const g of statusGroups) {
      statusCounts[g.status] = g._count._all;
    }
    const updatedCount = updatedGroups[0]?._count._all ?? 0;
    const summary = summaryFromStatusCounts(statusCounts, updatedCount);

    // 受付帳×所有者ジョブ判定をサーバ側で確定する（ページング後に client が
    // 現在ページ分の rows.some(...) で誤判定するのを防ぐ）。
    // owner_csv のときだけ判定が必要で、取込時に全行へマーカが付与される規約
    // (isReceptionOwnerJobRow) なので、先頭1行を読めば十分・低コスト。
    let isReceptionOwnerJob = false;
    if (job.jobType === "owner_csv") {
      const markerRow = await prisma.importJobRow.findFirst({
        where: { jobId },
        select: { rawData: true },
        orderBy: { rowNumber: "asc" },
      });
      isReceptionOwnerJob = isReceptionOwnerJobRow(
        job.jobType,
        (markerRow?.rawData ?? null) as Record<string, unknown> | null,
      );
    }

    const totalPages =
      limit !== null ? Math.max(1, Math.ceil(filteredTotal / limit)) : 1;
    const pagination = {
      page,
      // ページング無し時は「全件=1ページ」を表す。
      limit: limit ?? filteredTotal,
      totalRows: filteredTotal,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      status,
    };

    return apiResponse({
      ...job,
      rows,
      summary,
      isReceptionOwnerJob,
      duplicateCount,
      duplicateActionableCount,
      pagination,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
