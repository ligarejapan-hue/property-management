import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  getOwnerDisplayConfig,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { createOwnerSchema } from "@/lib/validators";
import { hasPermission, maskValue, hasExplicitWritePerm } from "@/lib/permissions";
import { normalizeName, normalizeAddress } from "@/lib/normalize";

// ---------- GET /api/owners ----------

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "owner", "read")) {
      throw new ApiError(403, "所有者閲覧の権限がありません", "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const keyword = searchParams.get("keyword") ?? "";
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
    const skip = (page - 1) * limit;

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};
    if (keyword) {
      where.OR = [
        { name: { contains: keyword, mode: "insensitive" } },
        { nameKana: { contains: keyword, mode: "insensitive" } },
        { phone: { contains: keyword } },
        { address: { contains: keyword, mode: "insensitive" } },
      ];
    }

    const [owners, total] = await Promise.all([
      prisma.owner.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          propertyOwners: {
            include: {
              property: {
                select: { id: true, address: true, propertyType: true },
              },
            },
          },
        },
      }),
      prisma.owner.count({ where }),
    ]);

    // Apply display-level masking based on user permissions
    const displayConfig = await getOwnerDisplayConfig(session.id);

    const maskedOwners = owners.map((owner) => ({
      id: owner.id,
      name: maskValue(owner.name, displayConfig.name),
      nameKana: maskValue(owner.nameKana, displayConfig.nameKana),
      phone: maskValue(owner.phone, displayConfig.phone),
      zip: maskValue(owner.zip, displayConfig.zip),
      address: maskValue(owner.address, displayConfig.address),
      note: maskValue(owner.note, displayConfig.note),
      externalLinkKey: owner.externalLinkKey,
      createdAt: owner.createdAt,
      updatedAt: owner.updatedAt,
      version: owner.version,
      properties: owner.propertyOwners.map((po) => ({
        id: po.property.id,
        address: po.property.address,
        propertyType: po.property.propertyType,
        relationship: po.relationship,
      })),
    }));

    await writeAuditLog({
      userId: session.id,
      action: "owner_list",
      targetTable: undefined,
      targetId: undefined,
      detail: { keyword, page, resultCount: total },
    });

    return apiResponse({
      data: maskedOwners,
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

// ---------- POST /api/owners ----------

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "owner", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const body = await request.json();
    const data = createOwnerSchema.parse(body);

    // Field-level write permission check（PATCH /api/owners/[id] と同方針）。
    // null/undefined のフィールドはスキップ（省略は許可）。
    // owner_email fallback は使わない（表示用 fallback と分離）。
    // 拒否時は DB アクセスおよび AuditLog 生成の前なので生値はログに残らない。
    const createFieldWriteChecks: Array<{ value: unknown; resource: string; label: string }> = [
      { value: data.name, resource: "owner_name", label: "name" },
      { value: data.nameKana, resource: "owner_name_kana", label: "nameKana" },
      { value: data.phone, resource: "owner_phone", label: "phone" },
      { value: data.zip, resource: "owner_zip", label: "zip" },
      { value: data.address, resource: "owner_address", label: "address" },
      { value: data.email, resource: "owner_email", label: "email" },
      { value: data.note, resource: "owner_note", label: "note" },
    ];
    for (const { value, resource, label } of createFieldWriteChecks) {
      if (value != null && !hasExplicitWritePerm(perms, resource)) {
        throw new ApiError(403, `${label} を書き込む権限がありません`, "FORBIDDEN");
      }
    }

    if (data.address) {
      const normName = normalizeName(data.name);
      const normAddr = normalizeAddress(data.address);
      const candidates = await prisma.owner.findMany({
        where: { address: { not: null } },
        select: { id: true, name: true, address: true },
      });
      const dup = candidates.find(
        (c) =>
          normalizeName(c.name) === normName &&
          normalizeAddress(c.address!) === normAddr,
      );
      if (dup) {
        throw new ApiError(
          409,
          `同じ氏名・住所の所有者が既に存在します (ID: ${dup.id})`,
          "DUPLICATE_OWNER",
        );
      }
    }

    const owner = await prisma.owner.create({
      data: {
        name: data.name,
        nameKana: data.nameKana,
        phone: data.phone,
        zip: data.zip,
        address: data.address,
        note: data.note,
        email: data.email,
        externalLinkKey: data.externalLinkKey,
      },
    });

    // AuditLog detail には氏名のみ。email 等の PII 生値は含めない。
    await writeAuditLog({
      userId: session.id,
      action: "create",
      targetTable: "owners",
      targetId: owner.id,
      detail: { name: owner.name },
    });

    return apiResponse(owner, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
