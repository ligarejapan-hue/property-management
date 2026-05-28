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
import { patchFieldSurveySessionSchema } from "@/lib/validators";

// ---------- PATCH /api/field-survey/sessions/[id] ----------
// 巡回終了 / cancel / memo 更新の最小対応。
// field_survey:write 必須。`manage` を持たない場合は own のみ操作可。
// 状態遷移 (ended / cancelled) は updateMany で `status="active"` を where 条件に
// 含めて atomic に判定する。Codex P2 (PATCH race) 対応:
//   2 つの並行 end/cancel が同じ active 行を read してから update した場合でも、
//   後発リクエストの updateMany は 0 行更新となり 409 INVALID_STATE を返す。

const SELECT_SESSION = {
  id: true,
  staffUserId: true,
  startedAt: true,
  endedAt: true,
  status: true,
  memo: true,
  pointCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------- GET /api/field-survey/sessions/[id] ----------
// Phase 1-J: 過去ルート閲覧の session メタ取得。
// - field_survey:read 必須。own は read のみ、他人は read_all または manage 必須。
// - 他人 session の閲覧時のみ AuditLog (field_survey_session_view)。
//   detail は sessionId / viewedStaffUserId / scope のみ (座標・memo・PII は入れない)。
// - 返却は id/staffUserId/staffName/startedAt/endedAt/status/pointCount/pinCount。
//   memo / 座標 / 写真情報は返さない。pinCount は archived を除く紐付け pin 数。

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

    const sess = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        pointCount: true,
        staff: { select: { name: true } },
      },
    });
    if (!sess) {
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

    const isOwn = sess.staffUserId === session.id;
    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    if (!isOwn && !hasReadAll && !hasManage) {
      throw new ApiError(403, "他スタッフの session は閲覧できません", "FORBIDDEN");
    }

    const pinCount = await prisma.fieldSurveyPin.count({
      where: { sessionId: id, status: { not: "archived" } },
    });

    if (!isOwn) {
      // 他人 session メタ閲覧のみ監査。detail に座標・memo・PII を入れない。
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_session_view",
        targetTable: "field_survey_sessions",
        targetId: id,
        detail: {
          sessionId: id,
          viewedStaffUserId: sess.staffUserId,
          scope: hasManage ? "manage" : "read_all",
        },
      });
    }

    return apiResponse({
      data: {
        id: sess.id,
        staffUserId: sess.staffUserId,
        staffName: sess.staff?.name ?? null,
        startedAt: sess.startedAt,
        endedAt: sess.endedAt,
        status: sess.status,
        pointCount: sess.pointCount,
        pinCount,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

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
    const patch = patchFieldSurveySessionSchema.parse(body);

    const existing = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: {
        id: true,
        staffUserId: true,
        startedAt: true,
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

    const now = new Date();

    if (patch.status === "ended" || patch.status === "cancelled") {
      // status 変更は atomic な conditional update で実施。
      // 0 行更新は「既に終了/キャンセル済」を意味し 409 にマップ。
      const result = await prisma.fieldSurveySession.updateMany({
        where: { id, status: "active" },
        data: {
          status: patch.status,
          endedAt: now,
          ...(patch.memo !== undefined && { memo: patch.memo }),
        },
      });
      if (result.count === 0) {
        throw new ApiError(
          409,
          "active 状態でない session は終了/キャンセルできません",
          "INVALID_STATE",
        );
      }
    } else if (patch.memo !== undefined) {
      // memo のみ更新は状態に依存しないため通常 update で十分。
      await prisma.fieldSurveySession.update({
        where: { id },
        data: { memo: patch.memo },
      });
    }

    const updated = await prisma.fieldSurveySession.findUnique({
      where: { id },
      select: SELECT_SESSION,
    });
    if (!updated) {
      // 直前まで存在していた行が消えるのは想定外。安全側で 404。
      throw new ApiError(404, "session が見つかりません", "NOT_FOUND");
    }

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
