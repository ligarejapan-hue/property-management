import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  parseJsonBody,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { patchFieldSurveyPinSchema } from "@/lib/validators";
import { assertPropertyAccessible } from "@/app/api/field-survey/pins/route";

const SELECT_PIN = {
  id: true,
  sessionId: true,
  staffUserId: true,
  propertyId: true,
  lat: true,
  lng: true,
  accuracy: true,
  pinType: true,
  status: true,
  memo: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ============================================================
// GET /api/field-survey/pins/[id]
// ============================================================
// - field_survey:read 必須。own は read のみで可、他人 pin は read_all/manage 必須。
// - 他人 pin 詳細閲覧時のみ AuditLog (action=field_survey_pin_view)。座標・memo 本文は detail に入れない。

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
      select: SELECT_PIN,
    });
    if (!pin) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = pin.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(
        403,
        "他スタッフの pin は閲覧できません",
        "FORBIDDEN",
      );
    }

    if (!isOwn) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_view",
        targetTable: "field_survey_pins",
        targetId: pin.id,
        detail: {
          pinId: pin.id,
          ownerStaffUserId: pin.staffUserId,
          hasProperty: pin.propertyId != null,
        },
      });
    }

    return apiResponse({ data: pin });
  } catch (error) {
    return handleApiError(error);
  }
}

// ============================================================
// PATCH /api/field-survey/pins/[id]
// ============================================================
// - field_survey:write 必須。own は更新可、他人 pin 更新は manage 必須。
// - office_staff (read_all のみ) では更新不可。
// - lat/lng は受け付けない (schema.strict() で 422)。
// - propertyId / sessionId の紐付け先には認可を再評価。
// - AuditLog: action=field_survey_pin_update / detail に座標・memo 本文を含めない。

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "更新権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const patch = patchFieldSurveyPinSchema.parse(body);

    const existing = await prisma.fieldSurveyPin.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        sessionId: true,
        propertyId: true,
        pinType: true,
        status: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, "pin が見つかりません", "NOT_FOUND");
    }

    const isOwn = existing.staffUserId === session.id;
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasManage) {
      throw new ApiError(
        403,
        "他スタッフの pin は更新できません",
        "FORBIDDEN",
      );
    }

    // sessionId 変更時の認可: active session のみ、non-manage は own session
    if (patch.sessionId !== undefined && patch.sessionId !== null) {
      const sess = await prisma.fieldSurveySession.findUnique({
        where: { id: patch.sessionId },
        select: { staffUserId: true, status: true },
      });
      if (!sess) {
        throw new ApiError(404, "session が見つかりません", "SESSION_NOT_FOUND");
      }
      if (!hasManage && sess.staffUserId !== session.id) {
        throw new ApiError(
          403,
          "他スタッフの session には紐付けられません",
          "FORBIDDEN",
        );
      }
      if (sess.status !== "active") {
        throw new ApiError(
          409,
          "active 状態でない session には紐付けられません",
          "INVALID_STATE",
        );
      }
    }

    // propertyId 変更時の認可
    if (patch.propertyId !== undefined && patch.propertyId !== null) {
      await assertPropertyAccessible(patch.propertyId, session, permissions);
    }

    const updated = await prisma.fieldSurveyPin.update({
      where: { id },
      data: {
        ...(patch.pinType !== undefined && { pinType: patch.pinType }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.memo !== undefined && { memo: patch.memo }),
        ...(patch.propertyId !== undefined && { propertyId: patch.propertyId }),
        ...(patch.sessionId !== undefined && { sessionId: patch.sessionId }),
      },
      select: SELECT_PIN,
    });

    const changedFields: string[] = [];
    if (patch.pinType !== undefined && patch.pinType !== existing.pinType) {
      changedFields.push("pinType");
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      changedFields.push("status");
    }
    if (patch.memo !== undefined) changedFields.push("memo");
    if (
      patch.propertyId !== undefined &&
      patch.propertyId !== existing.propertyId
    ) {
      changedFields.push("propertyId");
    }
    if (
      patch.sessionId !== undefined &&
      patch.sessionId !== existing.sessionId
    ) {
      changedFields.push("sessionId");
    }

    if (changedFields.length > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_update",
        targetTable: "field_survey_pins",
        targetId: updated.id,
        detail: {
          pinId: updated.id,
          changedFields,
          ...(changedFields.includes("status") && {
            statusBefore: existing.status,
            statusAfter: updated.status,
          }),
        },
      });
    }

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
