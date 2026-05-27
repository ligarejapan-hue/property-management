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
import { fieldSurveyMapPropertyListQuerySchema } from "@/lib/validators";

// ---------- GET /api/field-survey/map/properties ----------
//
// 現地調査マップに既存 Property を bbox 内で表示するための endpoint。
// 地図 pan/zoom で高頻度に呼ばれるため AuditLog は書かない。
//
// 権限:
//  - field_survey:read 必須 (画面利用権限)
//  - property:read 必須 (Property レコード閲覧権限)
//  - field_staff は既存 /api/properties と同じく createdBy/assignedTo scope を強制
//
// response:
//  - 地図表示に必要な最小フィールドのみ。
//  - owner 氏名・住所・電話など PII は一切含めない。
//  - rawData / memo 本文 / 監査詳細は含めない。

const SELECT_MAP_PROPERTY = {
  id: true,
  address: true,
  gpsLat: true,
  gpsLng: true,
  propertyType: true,
  registryStatus: true,
  dmStatus: true,
  caseStatus: true,
  updatedAt: true,
} as const;

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(
        403,
        "物件の閲覧権限がありません",
        "FORBIDDEN",
      );
    }

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((v, k) => {
      queryObj[k] = v;
    });
    const { north, south, east, west, limit, cursor, includeArchived } =
      fieldSurveyMapPropertyListQuerySchema.parse(queryObj);

    // 既存 /api/properties と整合する基本 where。
    //  - gpsLat / gpsLng が null の Property は地図に出せないので除外。
    //  - bbox 内に絞る。
    //  - includeArchived=false なら isArchived=false。
    const where: {
      gpsLat: { gte: number; lte: number; not: null };
      gpsLng: { gte: number; lte: number; not: null };
      isArchived?: false;
      AND?: { OR: { createdBy?: string; assignedTo?: string }[] }[];
    } = {
      gpsLat: { gte: south, lte: north, not: null },
      gpsLng: { gte: west, lte: east, not: null },
    };
    if (!includeArchived) {
      where.isArchived = false;
    }
    // field_staff scope: 既存 /api/properties (route.ts) と同じく createdBy /
    // assignedTo の OR を AND 条件として強制する。
    if (session.role === "field_staff") {
      where.AND = [
        {
          OR: [
            { createdBy: session.id },
            { assignedTo: session.id },
          ],
        },
      ];
    }

    // cursor pagination: orderBy [updatedAt desc, id desc]、id 基準で次ページ。
    const rows = await prisma.property.findMany({
      where,
      select: SELECT_MAP_PROPERTY,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 }
        : {}),
    });

    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasNext && data.length > 0 ? data[data.length - 1].id : null;

    return apiResponse({ data, nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}
