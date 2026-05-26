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
import {
  createFieldSurveySessionSchema,
  fieldSurveySessionListQuerySchema,
} from "@/lib/validators";

// Prisma の unique constraint 違反 (P2002) を class import なしで判定する。
// `@/generated/prisma` から Prisma.PrismaClientKnownRequestError を import すると
// Edge runtime や bundling の都合で副作用が出やすいため、duck typing で扱う。
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// ---------- POST /api/field-survey/sessions ----------
// 巡回開始。同一スタッフに active session が既にあれば 409 で安全側に倒す。

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "write")) {
      throw new ApiError(403, "巡回開始の権限がありません", "FORBIDDEN");
    }

    const body = await request.json().catch(() => ({}));
    const { memo } = createFieldSurveySessionSchema.parse(body);

    // 事前チェック (happy path のレイテンシ短縮と分かりやすいエラー応答用)。
    // race 条件は DB の partial unique index (one_active_per_staff_uniq) で
    // 担保し、P2002 を ACTIVE_SESSION_EXISTS にマップする (下記 catch)。
    const existingActive = await prisma.fieldSurveySession.findFirst({
      where: { staffUserId: session.id, status: "active" },
      select: { id: true },
    });
    if (existingActive) {
      throw new ApiError(
        409,
        "active な巡回 session が既に存在します。先に終了してください",
        "ACTIVE_SESSION_EXISTS",
      );
    }

    let created;
    try {
      created = await prisma.fieldSurveySession.create({
        data: {
          staffUserId: session.id,
          startedAt: new Date(),
          status: "active",
          memo: memo ?? null,
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
    } catch (err) {
      // partial unique index 違反 (同一 staff の active 重複) を 409 に変換。
      // 並行 POST のうち、後発リクエストは findFirst 後にここへ到達しうる。
      if (isPrismaUniqueViolation(err)) {
        throw new ApiError(
          409,
          "active な巡回 session が既に存在します。先に終了してください",
          "ACTIVE_SESSION_EXISTS",
        );
      }
      throw err;
    }

    await writeAuditLog({
      userId: session.id,
      action: "field_survey_session_start",
      targetTable: "field_survey_sessions",
      targetId: created.id,
      detail: { sessionId: created.id },
    });

    return apiResponse({ data: created }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- GET /api/field-survey/sessions ----------
// 自分の session 一覧（pagination 必須）。
// staffUserId クエリは field_survey:read_all 必須。read_all が無ければ
// 強制的に session.id でフィルタする（own only）。

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
    const { page, limit, staffUserId, status } =
      fieldSurveySessionListQuerySchema.parse(queryObj);

    const hasReadAll = hasPermission(permissions, "field_survey", "read_all");

    const where: {
      staffUserId?: string;
      status?: "active" | "ended" | "cancelled";
    } = {};

    if (hasReadAll) {
      if (staffUserId) where.staffUserId = staffUserId;
    } else {
      // own only: 他人 staffUserId 指定は無視して session.id 強制
      where.staffUserId = session.id;
    }
    if (status) where.status = status;

    const [total, sessions] = await Promise.all([
      prisma.fieldSurveySession.count({ where }),
      prisma.fieldSurveySession.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
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
      }),
    ]);

    return apiResponse({
      data: sessions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
