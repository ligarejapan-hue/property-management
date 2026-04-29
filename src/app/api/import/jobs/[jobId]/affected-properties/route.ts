import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { isUpdateMessage } from "@/lib/import-row-display";

// ---------- GET /api/import/jobs/:jobId/affected-properties ----------
//
// この取込で「作成 or 更新された物件」の一覧を返す。
//
// 仕様:
//   - 物件CSV取込ジョブ (jobType === "property_csv") のみ対象。
//     それ以外 (owner_csv / property_pdf / dm_history_csv / investigation_csv)
//     は applicable=false で返し、UI側で「対象外」扱いにする。
//   - status === "success" かつ createdId が NULL でない行を抽出。
//   - createdId を propertyId として bulk で properties を引いてくる。
//   - 既に削除されている物件は found=false で残し、UI で「削除済み」表示。
//
// 既存の /api/import/jobs/:jobId と同じ permission (import:write) を要求する。
// 現在その経路で見られる人は jobs.rows[].rawData["住所"] 等で物件特定情報に
// 既にアクセスできているため、address を返すことで権限境界は広がらない。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    // ジョブ存在確認 + jobType の取得（rows まで一気に load しない）
    const job = await prisma.importJob.findUnique({
      where: { id: jobId },
      select: { id: true, jobType: true },
    });

    if (!job) {
      throw new ApiError(404, "ジョブが見つかりません", "NOT_FOUND");
    }

    // 物件CSV以外は対象外。UIに "対象外" を伝えるだけで affected は空配列。
    if (job.jobType !== "property_csv") {
      return apiResponse({
        applicable: false,
        jobType: job.jobType,
        affected: [],
        createdCount: 0,
        updatedCount: 0,
        missingCount: 0,
      });
    }

    // success かつ createdId 有り の行だけを引く。
    // ImportJobRow は jobId+rowNumber に index あり、status は索引なしだが
    // 1ジョブ分なので行数は最大数千程度・パフォーマンス問題なし。
    const rows = await prisma.importJobRow.findMany({
      where: {
        jobId,
        status: "success",
        createdId: { not: null },
      },
      select: {
        rowNumber: true,
        errorMessage: true,
        createdId: true,
      },
      orderBy: { rowNumber: "asc" },
    });

    const propertyIds = Array.from(
      new Set(
        rows
          .map((r) => r.createdId)
          .filter((id): id is string => typeof id === "string" && id !== ""),
      ),
    );

    // bulk fetch。Property.address / lotNumber / buildingNumber / propertyType /
    // building.name までを一度に引く。building は optional リレーション。
    const properties =
      propertyIds.length > 0
        ? await prisma.property.findMany({
            where: { id: { in: propertyIds } },
            select: {
              id: true,
              address: true,
              lotNumber: true,
              buildingNumber: true,
              propertyType: true,
              roomNo: true,
              building: { select: { id: true, name: true } },
            },
          })
        : [];

    const byId = new Map(properties.map((p) => [p.id, p]));

    let createdCount = 0;
    let updatedCount = 0;
    let missingCount = 0;

    const affected = rows.map((row) => {
      const propertyId = row.createdId as string;
      const isUpdate = isUpdateMessage(row.errorMessage);
      const property = byId.get(propertyId);
      const found = !!property;

      if (!found) {
        missingCount++;
      } else if (isUpdate) {
        updatedCount++;
      } else {
        createdCount++;
      }

      return {
        rowNumber: row.rowNumber,
        propertyId,
        isUpdate,
        found,
        // UI 側でのラベル組み立てを楽にするため、引いた property を
        // 平らに展開して返す。見つからなかった場合は null。
        address: property?.address ?? null,
        lotNumber: property?.lotNumber ?? null,
        buildingNumber: property?.buildingNumber ?? null,
        roomNo: property?.roomNo ?? null,
        propertyType: property?.propertyType ?? null,
        buildingId: property?.building?.id ?? null,
        buildingName: property?.building?.name ?? null,
      };
    });

    return apiResponse({
      applicable: true,
      jobType: job.jobType,
      affected,
      createdCount,
      updatedCount,
      missingCount,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
