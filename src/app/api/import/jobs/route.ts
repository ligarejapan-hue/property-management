import { NextRequest } from "next/server";
import { Prisma, ImportJobType } from "@/generated/prisma";
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

// ---------- GET /api/import/jobs ----------
//
// クエリ:
//   jobType    : property_csv | owner_csv | dm_history_csv | investigation_csv | property_pdf
//   executedBy : User.id (uuid)
//   from       : ISO 日時 (createdAt の下限)
//   to         : ISO 日時 (createdAt の上限)
//   page       : 1始まり (default 1)
//   limit      : 1〜100 (default 50)
//
// レスポンス:
//   {
//     data: ImportJob[]   ← 各 job に summary フィールド (5区分集計) を付与
//     pagination: { page, limit, total, totalPages }
//   }
//
// 既存呼び出し元 (app/(dashboard)/import/page.tsx) は data 配列のみを参照
// しているので、追加した summary / pagination は壊さずに無視される。

const VALID_JOB_TYPES: readonly ImportJobType[] = [
  "property_csv",
  "owner_csv",
  "dm_history_csv",
  "investigation_csv",
  "property_pdf",
] as const;

function parseDateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const url = new URL(request.url);
    const jobTypeParam = url.searchParams.get("jobType");
    const executedByParam = url.searchParams.get("executedBy");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const pageParam = url.searchParams.get("page");
    const limitParam = url.searchParams.get("limit");

    const page = Math.max(1, Number(pageParam ?? "1") || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number(limitParam ?? "50") || 50),
    );

    const where: Prisma.ImportJobWhereInput = {};

    if (jobTypeParam) {
      // 不正な enum 値は黙って弾く（型安全）。完全一致のみ許可。
      if ((VALID_JOB_TYPES as readonly string[]).includes(jobTypeParam)) {
        where.jobType = jobTypeParam as ImportJobType;
      }
    }

    if (executedByParam) {
      where.executedBy = executedByParam;
    }

    const fromDate = parseDateOrNull(fromParam);
    const toDate = parseDateOrNull(toParam);
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = fromDate;
      if (toDate) where.createdAt.lte = toDate;
    }

    const [total, jobs] = await prisma.$transaction([
      prisma.importJob.count({ where }),
      prisma.importJob.findMany({
        where,
        include: {
          executor: { select: { id: true, name: true } },
          _count: { select: { rows: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // 各 job の 5 区分サマリを ImportJobRow から集約する。
    // 旧実装は全行を findMany して JS で Map 集計していたが、行数が増えると
    // 行の取得・転送コストが線形に膨らむため、Prisma groupBy 2 本に置き換える。
    //   ① jobId × status の件数（success 総数 / skipped / needs_review / error）
    //   ② jobId ごとの「更新」success 件数
    //      （success かつ errorMessage が「更新」始まり = isUpdateMessage 規約）
    // createdCount は ① の success 総数 − ② の更新件数で導出する。
    const jobIds = jobs.map((j) => j.id);

    // jobId → status 別件数。groupBy は 0 件 status を返さないため未指定キーは
    // summaryFromStatusCounts 側で 0 埋めされる。
    const statusCountsByJob = new Map<string, StatusCounts>();
    // jobId → 更新件数（②に現れない job は更新 0 件）。
    const updatedCountByJob = new Map<string, number>();

    // 現ページに job が無ければ集計クエリ自体を打たない（空 in を避ける）。
    if (jobIds.length > 0) {
      const [statusGroups, updatedGroups] = await Promise.all([
        prisma.importJobRow.groupBy({
          by: ["jobId", "status"],
          where: { jobId: { in: jobIds } },
          _count: { _all: true },
        }),
        prisma.importJobRow.groupBy({
          by: ["jobId"],
          where: {
            jobId: { in: jobIds },
            status: "success",
            // isUpdateMessage 規約と一致: errorMessage が「更新」始まりの行のみ。
            // null は startsWith にマッチしないため更新扱いされない。
            errorMessage: { startsWith: "更新" },
          },
          _count: { _all: true },
        }),
      ]);

      for (const g of statusGroups) {
        const entry = statusCountsByJob.get(g.jobId) ?? {};
        entry[g.status] = g._count._all;
        statusCountsByJob.set(g.jobId, entry);
      }
      for (const g of updatedGroups) {
        updatedCountByJob.set(g.jobId, g._count._all);
      }
    }

    // 「手動で failed 化されたジョブ」を AuditLog から逆引きする。
    // mark-failed エンドポイントが action="import_job_mark_failed" /
    // targetTable="import_jobs" / targetId=jobId で書き込んでいるので、
    // 現ページの jobIds に対する存在チェックだけ行えば十分。
    // 1件でもログがあれば true。
    const manualFailedSet = new Set<string>();
    if (jobIds.length > 0) {
      const manualFailedLogs = await prisma.auditLog.findMany({
        where: {
          action: "import_job_mark_failed",
          targetTable: "import_jobs",
          targetId: { in: jobIds },
        },
        select: { targetId: true },
      });
      for (const log of manualFailedLogs) {
        if (log.targetId) manualFailedSet.add(log.targetId);
      }
    }

    const data = jobs.map((job) => ({
      ...job,
      summary: summaryFromStatusCounts(
        statusCountsByJob.get(job.id) ?? {},
        updatedCountByJob.get(job.id) ?? 0,
      ),
      // status === "failed" でかつ AuditLog に該当ログがあれば手動失敗。
      // failed 以外で true になることは原則無いが、API 側で status と
      // 連動させる責務はクライアントへ持たせず、boolean だけ返す。
      isManuallyFailed: manualFailedSet.has(job.id),
    }));

    return apiResponse({
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
