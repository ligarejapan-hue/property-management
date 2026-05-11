import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
  getOwnerDisplayConfig,
} from "@/lib/api-helpers";
import { hasPermission, maskValue } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";

// ---------- GET /api/properties/suggest?q=... ----------
// 物件一覧の入力中候補表示用。property:read 必須。
// Owner PII は getOwnerDisplayConfig + maskValue で権限に応じてマスキング。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) {
      return apiResponse({ data: [] });
    }

    // ハイフン除去版でも phone を検索（入力側のハイフン有無を吸収）
    const qNoHyphen = q.replace(/-/g, "");
    const phoneConditions: { phone: { contains: string } }[] = [
      { phone: { contains: q } },
      ...(qNoHyphen !== q ? [{ phone: { contains: qNoHyphen } }] : []),
    ];

    const properties = await prisma.property.findMany({
      where: {
        isArchived: false,
        OR: [
          { address: { contains: q, mode: "insensitive" } },
          { lotNumber: { contains: q, mode: "insensitive" } },
          { realEstateNumber: { contains: q, mode: "insensitive" } },
          { buildingNumber: { contains: q, mode: "insensitive" } },
          {
            propertyOwners: {
              some: {
                owner: {
                  OR: [
                    { name: { contains: q, mode: "insensitive" } },
                    { address: { contains: q, mode: "insensitive" } },
                    { zip: { contains: q } },
                    ...phoneConditions,
                  ],
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        address: true,
        dmStatus: true,
        propertyOwners: {
          select: {
            owner: {
              select: {
                name: true,
                address: true,
                phone: true,
                zip: true,
              },
            },
          },
        },
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    });

    // importSource を一括逆引き（N+1 回避）
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

    // Owner PII をフィールド別に権限マスキング
    const displayConfig = await getOwnerDisplayConfig(session.id);

    const data = properties.map((p) => ({
      id: p.id,
      address: p.address,
      dmStatus: p.dmStatus,
      importSource: importSourceMap.get(p.id) ?? null,
      owners: p.propertyOwners.map(({ owner: o }) => ({
        name: maskValue(o.name, displayConfig.name),
        address: maskValue(o.address, displayConfig.address),
        phone: maskValue(o.phone, displayConfig.phone),
        zip: maskValue(o.zip, displayConfig.zip),
      })),
    }));

    // PII をログに含めない（qLen と件数のみ）
    await writeAuditLog({
      userId: session.id,
      action: "property_suggest",
      detail: { qLen: q.length, resultCount: data.length },
    });

    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
