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
    const {
      page,
      limit,
      keyword,
      propertyType,
      registryStatus,
      dmStatus,
      caseStatus,
      assignedTo,
      updatedFrom,
      updatedTo,
      includeArchived,
      hasWarning,
      sortBy,
      sortOrder,
    } = query;

    // Build where clause
    const where: any = {};

    if (!includeArchived) {
      where.isArchived = false;
    }

    if (propertyType) where.propertyType = propertyType;
    if (registryStatus) where.registryStatus = registryStatus;
    if (dmStatus) where.dmStatus = dmStatus;
    if (caseStatus) where.caseStatus = caseStatus;
    if (assignedTo) where.assignedTo = assignedTo;

    if (keyword) {
      where.OR = [
        { address: { contains: keyword, mode: "insensitive" } },
        { lotNumber: { contains: keyword, mode: "insensitive" } },
        { realEstateNumber: { contains: keyword, mode: "insensitive" } },
        { buildingNumber: { contains: keyword, mode: "insensitive" } },
      ];
    }

    if (updatedFrom || updatedTo) {
      where.updatedAt = {};
      if (updatedFrom) where.updatedAt.gte = new Date(updatedFrom);
      if (updatedTo) where.updatedAt.lte = new Date(updatedTo);
    }

    // For field_staff, only show assigned or self-created properties
    if (session.role === "field_staff") {
      where.OR = [
        { createdBy: session.id },
        { assignedTo: session.id },
        ...(where.OR || []),
      ];
    }

    // hasWarning: quality-check の "error" / "warning" 条件を OR で表現し、
    // 既存 where と AND する。"info" (NO_LOT_NUMBER 等) は粒度が細かいため除外。
    if (hasWarning === true) {
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { propertyOwners: { none: {} } }, // NO_OWNER
            {
              AND: [
                { registryStatus: "unconfirmed" },
                { dmStatus: "send" },
              ],
            }, // REGISTRY_DM_MISMATCH
            { investigationConfirmedAt: null }, // INVESTIGATION_NOT_CONFIRMED
            { assignedTo: null }, // NO_ASSIGNEE
          ],
        },
      ];
    }

    const [properties, total] = await Promise.all([
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
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.property.count({ where }),
    ]);

    // 取込元情報を一括逆引きして各物件に付与する（N+1 回避）
    const propertyIds = properties.map((p) => p.id);
    const importRows =
      propertyIds.length > 0
        ? await prisma.importJobRow.findMany({
            where: { createdId: { in: propertyIds }, status: "success" },
            select: {
              createdId: true,
              rowNumber: true,
              rawData: true,
              job: { select: { fileName: true } },
            },
            orderBy: { createdAt: "asc" },
          })
        : [];

    // createdId ごとに最初の行だけ残す
    const importSourceMap = new Map<string, string>();
    for (const row of importRows) {
      if (!importSourceMap.has(row.createdId!)) {
        const rd = (row.rawData as Record<string, string>) ?? {};
        importSourceMap.set(
          row.createdId!,
          rd.__sourceRef ?? `${row.job.fileName}:${row.rowNumber}行`,
        );
      }
    }

    const data = properties.map((p) => ({
      ...p,
      importSource: importSourceMap.get(p.id) ?? null,
      ownerNames: hasOwnerRead && ownerDisplayConfig
        ? p.propertyOwners
            .map(({ owner }) => maskValue(owner.name, ownerDisplayConfig.name))
            .filter((n): n is string => n !== null)
        : [],
    }));

    // Record audit log for list view
    await writeAuditLog({
      userId: session.id,
      action: "property_list",
      detail: { filters: queryObj, resultCount: total },
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
