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
import { patchFieldSurveySessionSchema } from "@/lib/validators";

// ---------- PATCH /api/field-survey/sessions/[id] ----------
// 巡回終了 / cancel / memo 更新の最小対応。
// field_survey:write 必須。`manage` を持たない場合は own のみ操作可。
// 既に ended/cancelled の session に再度終了を要求した場合は 409。

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

    const body = await request.json().catch(() => ({}));
    const patch = patchFieldSurveySessionSchema.parse(body);

    const existing = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        pointCount: true,
      },
    });
    if (!existing) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!hasManage && existing.staffUserId !== session.id) {
      throw new ApiError(
        403,
        "他スタッフの session は操作できません",
        "FORBIDDEN",
      );
    }

    // 状態遷移の事前チェック: ended / cancelled は再変更不可
    if (patch.status && existing.status !== "active") {
      throw new ApiError(
        409,
        "active 状態でない session は終了/キャンセルできません",
        "INVALID_STATE",
      );
    }

    const now = new Date();
    const updated = await prisma.fieldSurveySession.update({
      where: { id },
      data: {
        ...(patch.status === "ended" && {
          status: "ended",
          endedAt: now,
        }),
        ...(patch.status === "cancelled" && {
          status: "cancelled",
          endedAt: now,
        }),
        ...(patch.memo !== undefined && { memo: patch.memo }),
      },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        memo: true,
        pointCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (patch.status === "ended") {
      const durationSec = Math.max(
        0,
        Math.floor(
          (now.getTime() - existing.startedAt.getTime()) / 1000,
        ),
      );
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_end",
        targetTable: "field_survey_sessions",
        targetId: updated.id,
        detail: {
          sessionId: updated.id,
          durationSec,
          pointCount: existing.pointCount,
        },
      });
    } else if (patch.status === "cancelled") {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_cancel",
        targetTable: "field_survey_sessions",
        targetId: updated.id,
        detail: { sessionId: updated.id },
      });
    }

    return apiResponse({ data: updated });
  } catch (error) {
    return handleApiError(error);
  }
}
