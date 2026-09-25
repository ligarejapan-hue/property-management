/**
 * 添付済みの謄本(所有者事項)から、**所有者が空の物件をまとめて**埋める受付。
 *
 * 背景: 「謄本はあるのに所有者が空」の物件が本番に1,821件ある(2026-09-26 実測)。
 * 1件ずつのボタンと**同じ共通処理**を、裏で1件ずつ順番に呼ぶ。
 *
 *   GET  … 対象の件数を返すだけ(何も保存しない)
 *   POST … 取込ジョブを作り、裏の処理(ワーカー)に渡して 202 を返す
 *
 * ⚠取込記録の種別は既存の「所有者事項PDF一括」に**相乗り**する(データベースの
 *   種別を増やさない)。行は印で見分ける → `registry-owner-bulk/marker.ts`
 * ⚠**同時に2つ走らせない**。処理中のときは受け付けない(同じ物件を2回拾って
 *   「すでに所有者あり」の行が並ぶのを避ける+サーバ負荷の平準化)。
 * ⚠取込記録・監査に**所有者の氏名・住所は残さない**。行に残すのは物件IDと
 *   物件の住所(結果の一覧で「どの物件か」を示すため)だけ。
 */
import type { NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  enqueueRegistryPdfBulkJob,
  isRegistryPdfBulkWorkerBusy,
} from "@/lib/registry-pdf-bulk/worker";
import {
  REGISTRY_OWNER_APPLY_JOB_TYPE,
  REGISTRY_OWNER_APPLY_KIND,
  REGISTRY_OWNER_APPLY_KIND_KEY,
} from "@/lib/registry-owner-bulk/marker";
import {
  REGISTRY_OWNER_APPLY_DEFAULT_LIMIT,
  REGISTRY_OWNER_APPLY_MAX_LIMIT,
  buildRegistryOwnerApplyRowSeeds,
  parseRegistryOwnerApplyLimit,
} from "@/lib/registry-owner-bulk/plan";
import {
  REGISTRY_OWNER_APPLY_PERM_MESSAGES,
  findMissingRegistryOwnerApplyPerm,
} from "@/lib/registry-owner-bulk/permissions";

/** 取込記録に残す名前。⚠添付の生ファイル名は使わない(PIIを含みうる)。 */
const JOB_LABEL = "謄本から所有者をまとめて反映";

/** 対象の謄本の条件(所有者事項・削除されていない)。 */
const OWNER_REGISTRY_ATTACHMENT = {
  type: "registry",
  isDeleted: false,
  registryCertificateType: "owner",
} as const;

/** 権限を確かめる(管理者+取込+所有者の編集+氏名・住所の項目権限)。 */
async function assertCanApply() {
  const session = await getApiSession();
  const perms = await getUserPermissions(session.id);
  const missing = findMissingRegistryOwnerApplyPerm(session.role, perms);
  if (missing) {
    throw new ApiError(403, REGISTRY_OWNER_APPLY_PERM_MESSAGES[missing], "FORBIDDEN");
  }
  return { session, perms };
}

/** 対象の物件数(所有者が空 かつ 所有者事項の謄本あり)。 */
function countTargets() {
  return prisma.property.count({
    where: {
      propertyOwners: { none: {} },
      attachments: { some: { ...OWNER_REGISTRY_ATTACHMENT } },
    },
  });
}

/** 対象件数を返す(保存しない)。 */
export async function GET() {
  try {
    await assertCanApply();
    const targetCount = await countTargets();
    return apiResponse({
      targetCount,
      defaultLimit: REGISTRY_OWNER_APPLY_DEFAULT_LIMIT,
      maxLimit: REGISTRY_OWNER_APPLY_MAX_LIMIT,
      // ほかの取込が動いているか(動いている間は実行できない)
      busy: isRegistryPdfBulkWorkerBusy(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/** まとめて反映を始める。 */
export async function POST(request: NextRequest) {
  try {
    const { session } = await assertCanApply();

    const body = (await request.json().catch(() => null)) as { limit?: unknown } | null;
    const limit = parseRegistryOwnerApplyLimit(body?.limit ?? undefined);
    if (limit === null) {
      throw new ApiError(
        400,
        `今回処理する件数は 1〜${REGISTRY_OWNER_APPLY_MAX_LIMIT} の整数で指定してください`,
        "VALIDATION_ERROR",
      );
    }

    // ⚠二重に走らせない。(a) 終わっていない反映のジョブがある (b) ワーカーが動いている
    const unfinished = await prisma.importJob.findFirst({
      where: {
        jobType: REGISTRY_OWNER_APPLY_JOB_TYPE,
        status: { in: ["pending", "processing"] },
        rows: {
          some: {
            rawData: {
              path: [REGISTRY_OWNER_APPLY_KIND_KEY],
              equals: REGISTRY_OWNER_APPLY_KIND,
            },
          },
        },
      },
      select: { id: true },
    });
    if (unfinished) {
      throw new ApiError(
        409,
        "まだ終わっていない反映があります。取込の記録で進み具合を確認してください",
        "REGISTRY_OWNER_APPLY_IN_PROGRESS",
      );
    }
    if (isRegistryPdfBulkWorkerBusy()) {
      throw new ApiError(
        409,
        "ほかの取込を処理中です。終わってからもう一度実行してください",
        "IMPORT_BUSY",
      );
    }

    // 対象を「謄本(添付)が古い順」に取り出す。⚠同じ物件の謄本が複数あっても
    //   行は1つにまとめる(buildRegistryOwnerApplyRowSeeds が重複を落とす)。
    const attachments = await prisma.attachment.findMany({
      where: {
        ...OWNER_REGISTRY_ATTACHMENT,
        property: { propertyOwners: { none: {} } },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { propertyId: true, property: { select: { address: true } } },
    });
    const seeds = buildRegistryOwnerApplyRowSeeds(
      attachments
        .filter((a): a is typeof a & { propertyId: string } => !!a.propertyId)
        .map((a) => ({ id: a.propertyId, address: a.property?.address ?? null })),
    );
    if (seeds.length === 0) {
      return apiResponse({ jobId: null, totalRows: 0 });
    }

    const job = await prisma.importJob.create({
      data: {
        jobType: REGISTRY_OWNER_APPLY_JOB_TYPE,
        // ⚠固定の名前。添付の生ファイル名は使わない。
        fileName: JOB_LABEL,
        status: "pending",
        totalRows: seeds.length,
        executedBy: session.id,
      },
      select: { id: true },
    });
    await prisma.importJobRow.createMany({
      data: seeds.map((seed) => ({
        jobId: job.id,
        rowNumber: seed.rowNumber,
        status: seed.status,
        rawData: seed.rawData,
      })),
    });

    await writeAuditLog({
      userId: session.id,
      action: "registry_owner_bulk_apply",
      targetTable: "import_jobs",
      targetId: job.id,
      // 非PII(件数とジョブIDだけ)
      detail: { jobId: job.id, totalRows: seeds.length },
    });

    // 裏の処理へ(既存の待機列に乗せる=同時に走る処理は常に1つ)
    enqueueRegistryPdfBulkJob(job.id);

    return apiResponse({ jobId: job.id, totalRows: seeds.length }, 202);
  } catch (error) {
    return handleApiError(error);
  }
}
