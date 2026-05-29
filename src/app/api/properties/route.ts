import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  handleApiError,
  apiResponse,
  ApiError,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { hasPermission, maskValue } from "@/lib/permissions";
import {
  propertyListQuerySchema,
  createPropertySchema,
} from "@/lib/validators";
import {
  buildPropertyListWhere,
  buildPropertyListOrderBy,
  loadImportSourceMap,
} from "@/lib/property-list-query";

// ---------- GET /api/properties ----------

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(
        403,
        "物件一覧の閲覧権限がありません",
        "FORBIDDEN",
      );
    }

    const hasOwnerRead = hasPermission(permissions, "owner", "read");
    const ownerDisplayConfig = hasOwnerRead
      ? await getOwnerDisplayConfig(session.id)
      : null;

    const { searchParams } = new URL(request.url);
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    const query = propertyListQuerySchema.parse(queryObj);
    const { page, limit } = query;

    // 検索条件（where / sort）は CSV export と共有する単一ロジックで組み立てる
    // （src/lib/property-list-query.ts）。条件ズレ防止のためここでは直接構築しない。
    const { where, mgmtShortCircuitEmpty, mgmtHitCount, mgmtIdTrimmed } =
      await buildPropertyListWhere(query, session);
    const orderBy = buildPropertyListOrderBy(query);

    const fetchListAndCount = () =>
      Promise.all([
        prisma.property.findMany({
          where,
          select: {
            id: true,
            propertyType: true,
            address: true,
            lotNumber: true,
            buildingNumber: true,
            realEstateNumber: true,
            registryStatus: true,
            dmStatus: true,
            caseStatus: true,
            introductionRoute: true,
            isArchived: true,
            updatedAt: true,
            assignedTo: true,
            gpsLat: true,
            gpsLng: true,
            investigationConfirmedAt: true,
            assignee: { select: { id: true, name: true } },
            propertyOwners: {
              select: { owner: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.property.count({ where }),
      ]);

    type FetchResult = Awaited<ReturnType<typeof fetchListAndCount>>;
    const [properties, total]: FetchResult = mgmtShortCircuitEmpty
      ? [[], 0]
      : await fetchListAndCount();

    // 取込元情報を一括逆引きして各物件に付与する（N+1 回避）。
    // CSV export と共有する loadImportSourceMap を再利用する。
    const importSourceMap = await loadImportSourceMap(
      prisma,
      properties.map((p) => p.id),
    );

    const data = properties.map((p) => {
      const { propertyOwners, ...property } = p;
      return {
        ...property,
        importSource: importSourceMap.get(p.id) ?? null,
        ownerNames: hasOwnerRead && ownerDisplayConfig
          ? propertyOwners
              .map(({ owner }) => maskValue(owner.name, ownerDisplayConfig.name))
              .filter((n): n is string => n !== null)
          : [],
      };
    });

    // Record audit log for list view.
    // mgmtId 値そのものはログに残さず、長さと hit 件数のみを記録する
    // （管理ID 検索語は外部由来のファイル名・行番号を含むため）。
    const { mgmtId: _omitMgmtId, ...filtersForLog } = queryObj;
    await writeAuditLog({
      userId: session.id,
      action: "property_list",
      detail: {
        filters: filtersForLog,
        resultCount: total,
        ...(mgmtIdTrimmed
          ? { mgmtIdLen: mgmtIdTrimmed.length, mgmtHitCount }
          : {}),
      },
    });

    return apiResponse({
      data,
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

// ---------- POST /api/properties ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "物件登録の権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = createPropertySchema.parse(body);

    const property = await prisma.property.create({
      data: {
        ...data,
        createdBy: session.id,
      },
      include: {
        assignee: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "properties",
      targetId: property.id,
      detail: { propertyType: data.propertyType, address: data.address },
    });

    return apiResponse(property, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
