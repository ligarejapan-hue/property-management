import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  parseJsonBody,
  ApiError,
  type ApiSession,
  type PermissionEntry,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import {
  createFieldSurveyPinSchema,
  fieldSurveyPinListQuerySchema,
} from "@/lib/validators";

// ============================================================
// POST /api/field-survey/pins
// ============================================================
// - field_survey:write 必須。staffUserId は body から受け取らず session.id 固定。
// - sessionId 指定時: 存在 + active のみ許可、non-manage は own session のみ。
// - propertyId 指定時: property:read + field_staff scope (createdBy/assignedTo)。
//   ※ 「判断不能なら manage 限定」の代替として、既存 property:read + own scope を踏襲。
// - AuditLog: action=field_survey_pin_create / detail に座標・memo 本文は入れない。

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

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "pin の作成権限がありません", "FORBIDDEN");
    }

    const body = await parseJsonBody(request);
    const input = createFieldSurveyPinSchema.parse(body);

    const hasManage = hasPermission(permissions, "field_survey", "manage");

    // sessionId 検証
    if (input.sessionId) {
      const sess = await prisma.fieldSurveySession.findUnique({
        where: { id: input.sessionId },
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

    // propertyId 検証 (既存 properties API の field_staff scope と整合)
    if (input.propertyId) {
      await assertPropertyAccessible(
        input.propertyId,
        session,
        permissions,
      );
    }

    const created = await prisma.fieldSurveyPin.create({
      data: {
        sessionId: input.sessionId ?? null,
        staffUserId: session.id,
        propertyId: input.propertyId ?? null,
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy ?? null,
        pinType: input.pinType,
        status: "open",
        memo: input.memo ?? null,
      },
      select: SELECT_PIN,
    });

    await writeAuditLog({
      userId: session.id,
      action: "field_survey_pin_create",
      targetTable: "field_survey_pins",
      targetId: created.id,
      detail: {
        pinId: created.id,
        pinType: created.pinType,
        status: created.status,
        hasSession: input.sessionId != null,
        hasProperty: input.propertyId != null,
      },
    });

    return apiResponse({ data: created }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

// ============================================================
// GET /api/field-survey/pins
// ============================================================
// - field_survey:read 必須。
// - non-(read_all|manage) は own のみ。read_all/manage は staffUserId クエリ可。
// - archived はデフォルト除外。includeArchived=true で含める (status クエリと併用時は status を優先)。
// - cursor は pin.id (UUID)。orderBy createdAt desc + id desc で安定ソート、take limit+1 で nextCursor 判定。
// - AuditLog: 他人 pin を明示的に閲覧した一覧取得 (= staffUserId クエリが session.id 以外) でのみ記録。
//   高頻度 map 表示で AuditLog を肥大化させないための判断。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });
    const query = fieldSurveyPinListQuerySchema.parse(queryObj);

    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");
    const hasManage = hasPermission(permissions, "field_survey", "manage");
    const canSeeOthers = hasReadAll || hasManage;

    const where: {
      staffUserId?: string;
      status?: "open" | "closed" | "archived" | { not: "archived" };
      pinType?: string;
      sessionId?: string;
      propertyId?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = {};

    if (canSeeOthers) {
      if (query.staffUserId) where.staffUserId = query.staffUserId;
    } else {
      // own only。staffUserId クエリは無視して session.id 強制。
      where.staffUserId = session.id;
    }

    if (query.status) {
      where.status = query.status;
    } else if (!query.includeArchived) {
      where.status = { not: "archived" };
    }
    if (query.pinType) where.pinType = query.pinType;
    if (query.sessionId) where.sessionId = query.sessionId;
    if (query.propertyId) where.propertyId = query.propertyId;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const rows = await prisma.fieldSurveyPin.findMany({
      where,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: SELECT_PIN,
    });

    const hasNext = rows.length > query.limit;
    const data = hasNext ? rows.slice(0, query.limit) : rows;
    const nextCursor =
      hasNext && data.length > 0 ? data[data.length - 1].id : null;

    // 明示的に他スタッフの pin を絞り込んだ list 取得のみ監査対象。
    if (canSeeOthers && query.staffUserId && query.staffUserId !== session.id) {
      await writeAuditLog({
        userId: session.id,
        action: "field_survey_pin_list_others",
        targetTable: "field_survey_pins",
        detail: {
          viewedStaffUserId: query.staffUserId,
          pinsReturned: data.length,
          hasSessionFilter: query.sessionId != null,
          hasPropertyFilter: query.propertyId != null,
        },
      });
    }

    return apiResponse({ data, nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}

// ============================================================
// helper: property 認可 (既存 properties API の field_staff scope と整合)
// ============================================================

export async function assertPropertyAccessible(
  propertyId: string,
  session: ApiSession,
  permissions: PermissionEntry[],
): Promise<void> {
  if (!hasPermission(permissions, "property", "read")) {
    throw new ApiError(
      403,
      "property の閲覧権限がありません",
      "FORBIDDEN",
    );
  }
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!property) {
    throw new ApiError(404, "property が見つかりません", "PROPERTY_NOT_FOUND");
  }
  if (
    session.role === "field_staff" &&
    property.createdBy !== session.id &&
    property.assignedTo !== session.id
  ) {
    throw new ApiError(
      403,
      "この property を pin に紐付ける権限がありません",
      "FORBIDDEN",
    );
  }
}
