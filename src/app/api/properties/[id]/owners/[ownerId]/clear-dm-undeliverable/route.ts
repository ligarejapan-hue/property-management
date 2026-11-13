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
import { assertPropertyRecordAccess } from "@/lib/property-record-guard";
import { writeAuditLog } from "@/lib/audit";
import { clearOwnerUndeliverable } from "@/lib/dm-reaction/clear-undeliverable";

// POST /api/properties/[id]/owners/[ownerId]/clear-dm-undeliverable
//
// 宛先不明の解除(2026-11-13 発注者決定)。所有者の登記上の住所を別の住所に替えたあとに呼ぶ。
// その所有者だけに、所有者の住所あてで送った「宛先不明」を、送付対象から外す理由に数えなくする
// (記録は宛先不明のまま残す)。物件に宛先不明が残らなければ「宛先不明」の印を外し、その印で
// 「送らない」になっていた DM 可否を「送付可」に戻す。
//
// 権限(発注者決定=住所を編集できる人なら誰でも):
//   - 所有者の編集(owner:write)と、住所・郵便番号の両方を書ける(owner_address / owner_zip)
//   - 物件の編集(property:write)=DM 可否を戻すため。現場担当は担当する物件だけ
// ⚠拒否(お断り)は解除しない。共有でまとめて送った記録・物件の住所あての記録も解除しない
//   (件数だけ返す)。決まりは dm-reaction/core.ts の isClearableUndeliverableLog。
// ⚠応答・監査に氏名・住所は出さない(件数だけ)。
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ownerId: string }> },
) {
  try {
    const { id: propertyId, ownerId } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (
      !hasPermission(permissions, "owner", "write") ||
      !hasExplicitWritePerm(permissions, "owner_address") ||
      !hasExplicitWritePerm(permissions, "owner_zip")
    ) {
      throw new ApiError(
        403,
        "宛先不明を解除するには、所有者の住所と郵便番号を編集できる権限が必要です",
        "FORBIDDEN",
      );
    }
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件を更新する権限(write)がありません", "FORBIDDEN");
    }
    await assertPropertyRecordAccess(propertyId, session, "write");

    // この物件の所有者であること(別の物件の画面から、関係ない所有者の記録を解除させない)
    const link = await prisma.propertyOwner.findUnique({
      where: { propertyId_ownerId: { propertyId, ownerId } },
      select: { id: true },
    });
    if (!link) {
      throw new ApiError(404, "この物件の所有者が見つかりません", "NOT_FOUND");
    }

    const result = await prisma.$transaction(
      (tx) => clearOwnerUndeliverable(tx, { ownerId, session, now: new Date() }),
      { timeout: 20_000, maxWait: 10_000 },
    );

    const counts = {
      cleared: result.cleared,
      sharedSkipped: result.sharedSkipped,
      otherSkipped: result.otherSkipped,
      flagsCleared: result.flagsCleared,
      dmStatusRestored: result.dmStatusRestored,
    };
    // 非PII の監査(件数だけ・氏名や住所は残さない)
    await writeAuditLog({
      userId: session.id,
      action: "dm_undeliverable_clear",
      targetTable: "owners",
      targetId: ownerId,
      detail: { propertyId, ...counts },
    });

    return apiResponse(counts);
  } catch (error) {
    return handleApiError(error);
  }
}
