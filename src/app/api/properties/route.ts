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
      ? await getOwnerDisplayConfig(session.id, permissions)
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
            dmUndeliverableAt: true,
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
            // DM送信回数(PropertyDmLog 件数)。一覧の「送信◯回」表示・送信回数の並べ替え/抽出に使う。
            _count: { select: { dmLogs: true } },
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

    // 一覧レスポンスに importSource（取込元管理ID）は含めない。
    // 一覧 UI は描画しておらず、loadImportSourceMap の ImportJobRow 逆引き
    // （rawData JSONB select 込み）が毎回走るのは無駄なため除去（17-C F1）。
    // 必要な経路は各自取得する: 詳細 GET / CSV export / dm-export / suggest。
    const data = properties.map((p) => {
      const { propertyOwners, _count, ...property } = p;
      return {
        ...property,
        // _count は select 指定で実クエリでは常に付くが、テストの findMany モックには無いことがあるため null 安全に。
        dmSentCount: _count?.dmLogs ?? 0,
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
