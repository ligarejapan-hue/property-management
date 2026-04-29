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
import { calcImportSummary } from "@/lib/import-summary";

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

    // 各 job の summary を ImportJobRow から動的計算する。
    // 行件数次第でレスポンスが膨らむのを避けるため select を最小化し、
    // 「status / errorMessage」の 2 列だけを引いてくる。
    const jobIds = jobs.map((j) => j.id);
    const rows =
      jobIds.length > 0
        ? await prisma.importJobRow.findMany({
            where: { jobId: { in: jobIds } },
            select: { jobId: true, status: true, errorMessage: true },
          })
        : [];

    const rowsByJob = new Map<
      string,
      Array<{
        status: "success" | "error" | "skipped" | "needs_review";
        errorMessage: string | null;
      }>
    >();
    for (const r of rows) {
      const list = rowsByJob.get(r.jobId);
      if (list) {
        list.push({ status: r.status, errorMessage: r.errorMessage });
      } else {
        rowsByJob.set(r.jobId, [
          { status: r.status, errorMessage: r.errorMessage },
        ]);
      }
    }

    const data = jobs.map((job) => ({
      ...job,
      summary: calcImportSummary(rowsByJob.get(job.id) ?? []),
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
