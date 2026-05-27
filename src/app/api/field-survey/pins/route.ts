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

    // sessionId 検証
    // POST 時は pin.staffUserId = session.id 固定のため、pin owner と session owner
    // を一致させるには session.staffUserId === session.id を必須にする。
    // manage を持つユーザーであっても、他スタッフ所有の session に自分の pin を
    // 紐付けることは own/read_all/manage 境界を崩すため禁止 (Codex P1-1)。
    if (input.sessionId) {
      const sess = await prisma.fieldSurveySession.findUnique({
        where: { id: input.sessionId },
        select: { staffUserId: true, status: true },
      });
      if (!sess) {
        throw new ApiError(404, "session が見つかりません", "SESSION_NOT_FOUND");
      }
      if (sess.staffUserId !== session.id) {
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
      lat?: { gte: number; lte: number };
      lng?: { gte: number; lte: number };
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
    // bbox は 4 値同時指定が validator で保証されている。Map UI の現在
    // viewport の pin だけ取るため、read_all/manage を持つ閲覧者でも
    // viewport 外の pin は返さない (Codex P2: pin fetch を bbox スコープに)。
    if (
      query.north !== undefined &&
      query.south !== undefined &&
      query.east !== undefined &&
      query.west !== undefined
    ) {
      where.lat = { gte: query.south, lte: query.north };
      where.lng = { gte: query.west, lte: query.east };
    }

    // view=map は Map UI 用の projection。memo 本文を response から完全除外し、
    // 内部で hasMemo: boolean のみ算出して返す。それ以外は既存 generic projection。
    // Codex Phase 1-E: Map UI の Network レスポンスに memo 本文を載せない。
    const rows = await prisma.fieldSurveyPin.findMany({
      where,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: SELECT_PIN,
    });

    const hasNext = rows.length > query.limit;
    const sliced = hasNext ? rows.slice(0, query.limit) : rows;
    const data =
      query.view === "map"
        ? sliced.map((r) => {
            // destructuring で memo を server side で剥がしてから response に渡す。
            // hasMemo は trim 後の長さで判定 (null / 空文字 / 空白のみは false)。
            const { memo, ...rest } = r;
            return {
              ...rest,
              hasMemo:
                typeof memo === "string" && memo.trim().length > 0,
            };
          })
        : sliced;
    const nextCursor =
      hasNext && sliced.length > 0 ? sliced[sliced.length - 1].id : null;

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
