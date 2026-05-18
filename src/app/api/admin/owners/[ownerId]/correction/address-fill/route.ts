import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission, hasExplicitWritePerm } from "@/lib/permissions";
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
//   - owner:read（所有者閲覧権）
//   - owner:write（所有者更新権）
//   - owner_address full または edit（フィールドレベル書込権）
//
// 安全条件（すべて API 側で再検証）:
//   - Owner.address が null または空文字
//   - ImportJobRow (owner_csv) が ownerId から一意（1件）に特定できる
//     0件 → import_source_unknown / 2件以上 → import_source_ambiguous
//   - ImportJobRow.status が success
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
    if (!hasPermission(perms, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "所有者更新の権限がありません", "FORBIDDEN");
    }
    if (!hasExplicitWritePerm(perms, "owner_address")) {
      throw new ApiError(403, "所有者住所を更新する権限がありません", "FORBIDDEN");
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

    // ImportJobRow 取得。一意性を確認するため全件取得して件数を判定する。
    // 複数件の中から success を勝手に選ばない。
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
    // importRowCount が 0 / 2以上 の場合は safety check で弾く。1件のときのみ参照。
    const importRow = importRows.length === 1 ? importRows[0] : null;

    // address フィールドの ChangeLog 存在チェック
    const addressChangeLog = await prisma.changeLog.findFirst({
      where: {
        targetTable: "owners",
        targetId: ownerId,
        fieldName: "address",
      },
      select: { id: true },
    });

    // rawData から住所を抽出（importRow が null の場合は extractedAddress も null になる）
    const rawData = importRow?.rawData as Record<string, unknown> | null;
    const extracted = extractAddressFromRawData(rawData);

    // 安全条件チェック
    const safety = checkAddressFillSafety({
      currentAddress: owner.address,
      importRowCount: importRows.length,
      importRowSuccess: importRow?.status === "success",
      addressChangeLogExists: addressChangeLog !== null,
      extractedAddress: extracted?.address ?? null,
    });

    if (!safety.ok) {
      const statusMap: Record<string, number> = {
        address_already_set: 409,
        import_source_unknown: 422,
        import_source_ambiguous: 422,
        import_row_not_success: 422,
        address_changelog_exists: 422,
        no_address_in_rawdata: 422,
      };
      const msgMap: Record<string, string> = {
        address_already_set: "住所はすでに設定されています",
        import_source_unknown: "取込元の ImportJobRow が見つかりません",
        import_source_ambiguous: "取込元の ImportJobRow が複数存在するため一意に特定できません",
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
    // version + 1 を先に計算。transaction が throw すれば newVersion は使われない。
    //
    // 【制限】where 条件は null / "" のみ。空白のみ住所（例: "   "）は事前チェックで
    // trim().length === 0 として補完対象とするが、Prisma の updateMany では
    // DB 側の TRIM() を where に組み込めないため、空白のみ住所が来ると
    // count=0 → CONFLICT になる。空白のみ住所は通常データとして稀なため
    // Phase 1 ではコメントで限界を明記し、対応は Phase 2 以降とする。
    const newVersion = version + 1;
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
        version: newVersion,
        updatedFields: ["address"],
      },
      201,
    );
  } catch (error) {
    return handleApiError(error);
  }
}
