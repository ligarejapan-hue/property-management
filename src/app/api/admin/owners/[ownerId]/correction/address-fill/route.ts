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
import { recordChanges, OWNER_TRACKED_FIELDS } from "@/lib/change-log";
import { writeAuditLog } from "@/lib/audit";
import {
  extractAddressFromRawData,
  checkAddressFillSafety,
} from "@/lib/owner-correction";

// ---------------------------------------------------------------------------
// POST /api/admin/owners/:ownerId/correction/address-fill
// ---------------------------------------------------------------------------
// 権限:
//   - user_management:read（管理者エリア）
//   - owner:write（所有者更新権）
//
// 安全条件（すべて API 側で再検証）:
//   - Owner.address が null または空文字
//   - ImportJobRow (owner_csv) が存在し status=success
//   - address フィールドの ChangeLog が存在しない
//   - ImportJobRow.rawData から住所を抽出できる
//
// Request body:
//   { version: number }  — 楽観ロック用
//
// Success (201):
//   { id, version, updatedFields: ["address"] }  ← 住所値は返さない
//
// Errors:
//   400: version が数値でない
//   403: 権限不足
//   404: Owner または ImportJobRow not found
//   409: version mismatch または address が既に設定済み
//   422: 安全条件不満足
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ownerId: string }> },
) {
  try {
    const { ownerId } = await params;
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    // 権限チェック（admin ゲートを先に）
    if (!hasPermission(perms, "user_management", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者更新の権限がありません", "FORBIDDEN");
    }

    // リクエストボディ
    const body = await request.json().catch(() => ({}));
    const version = body?.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new ApiError(400, "version は正の整数で指定してください", "INVALID_INPUT");
    }

    // Owner 取得（address の現在値を含む）
    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
      select: { id: true, address: true, version: true, isArchived: true },
    });
    if (!owner || owner.isArchived) {
      throw new ApiError(404, "所有者が見つかりません", "NOT_FOUND");
    }

    // ImportJobRow 取得（owner_csv の success 行を優先）
    const importRows = await prisma.importJobRow.findMany({
      where: {
        createdId: ownerId,
        job: { jobType: "owner_csv" },
      },
      select: {
        id: true,
        rowNumber: true,
        status: true,
        rawData: true,
        job: { select: { id: true, fileName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const importRow =
      importRows.find((r) => r.status === "success") ?? importRows[0] ?? null;

    // address フィールドの ChangeLog 存在チェック
    const addressChangeLog = await prisma.changeLog.findFirst({
      where: {
        targetTable: "owners",
        targetId: ownerId,
        fieldName: "address",
      },
      select: { id: true },
    });

    // rawData から住所を抽出
    const rawData = importRow?.rawData as Record<string, unknown> | null;
    const extracted = extractAddressFromRawData(rawData);

    // 安全条件チェック
    const safety = checkAddressFillSafety({
      currentAddress: owner.address,
      importRowExists: importRow !== null,
      importRowSuccess: importRow?.status === "success",
      addressChangeLogExists: addressChangeLog !== null,
      extractedAddress: extracted?.address ?? null,
    });

    if (!safety.ok) {
      const statusMap: Record<string, number> = {
        address_already_set: 409,
        import_source_unknown: 422,
        import_row_not_success: 422,
        address_changelog_exists: 422,
        no_address_in_rawdata: 422,
      };
      const msgMap: Record<string, string> = {
        address_already_set: "住所はすでに設定されています",
        import_source_unknown: "取込元の ImportJobRow が見つかりません",
        import_row_not_success: "取込行が success 状態ではありません",
        address_changelog_exists: "住所フィールドの変更履歴があるため補完できません",
        no_address_in_rawdata: "取込データから住所を抽出できませんでした",
      };
      throw new ApiError(
        statusMap[safety.reason] ?? 422,
        msgMap[safety.reason] ?? "住所補完の安全条件を満たしていません",
        "ADDRESS_FILL_BLOCKED",
      );
    }

    const newAddress = safety.address;

    // transaction: Owner update + ChangeLog
    // updateMany の where に address 条件を含め、既存住所への上書きを防止する。
    let newVersion: number;
    await prisma.$transaction(async (tx) => {
      const result = await tx.owner.updateMany({
        where: {
          id: ownerId,
          version,
          OR: [{ address: null }, { address: "" }],
        },
        data: {
          address: newAddress,
          version: { increment: 1 },
        },
      });

      if (result.count === 0) {
        // version mismatch または address がすでに入っている
        const current = await tx.owner.findUnique({
          where: { id: ownerId },
          select: { version: true, address: true },
        });
        if (current && current.address && current.address.trim().length > 0) {
          throw new ApiError(409, "住所はすでに設定されています", "ADDRESS_ALREADY_SET");
        }
        throw new ApiError(409, "他のユーザーが先に更新しました", "CONFLICT");
      }

      newVersion = version + 1;

      await tx.changeLog.createMany({
        data: [
          {
            targetTable: "owners",
            targetId: ownerId,
            fieldName: "address",
            oldValue: null,
            newValue: newAddress,
            source: "api",
            changedBy: session.id,
          },
        ],
      });
    });

    // AuditLog（transaction 外・non-blocking）
    // 住所の値は入れない。sourceFieldNames で何を参照したかだけ記録。
    await writeAuditLog({
      userId: session.id,
      action: "owner_correction_address_fill",
      targetTable: "owners",
      targetId: ownerId,
      detail: {
        correctionType: "address_fill",
        sourceType: "import_job_row",
        sourceRowId: importRow!.id,
        sourceJobId: importRow!.job.id,
        updatedFields: ["address"],
        sourceFieldNames: extracted!.sourceFieldNames,
      },
    });

    return apiResponse(
      {
        id: ownerId,
        version: newVersion!,
        updatedFields: ["address"],
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
