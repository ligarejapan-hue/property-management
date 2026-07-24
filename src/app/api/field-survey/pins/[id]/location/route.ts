import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

// ============================================================
// GET /api/field-survey/pins/[id]/location
// ============================================================
// 「この場所を地図で見る」導線 (?focusPin) 用の座標のみ射影。
// - 詳細 GET (/pins/[id]) は SELECT_PIN で memo 本文まで返すため、位置だけ見る
//   操作でクライアントメモリに生 memo を乗せてしまう (view=map 射影が守っている
//   保護の後退)。位置表示には lat/lng だけを返す (@codex P2)。
// - 認可は詳細 GET と同一: field_survey:read 必須、own は read で可、他人 pin は
//   read_all / manage 必須。他人 pin の閲覧は field_survey_pin_view を監査に残す
//   (座標・memo は監査 detail に入れない)。
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const pin = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: { id: true, staffUserId: true, lat: true, lng: true },
    });
    if (!pin) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = pin.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(403, "他スタッフの pin は閲覧できません", "FORBIDDEN");
    }

    if (!isOwn) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_view",
        targetTable: "field_survey_pins",
        targetId: pin.id,
        // 座標は監査 detail に入れない (id / owner のみ)。
        detail: { pinId: pin.id, ownerStaffUserId: pin.staffUserId },
      });
    }

    // Decimal → number に寄せて返す (view=map と同方針)。memo / staffUserId 等は返さない。
    return apiResponse({
      data: { lat: Number(pin.lat), lng: Number(pin.lng) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
