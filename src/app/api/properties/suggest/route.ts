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

    // 数字のみ抽出（DB・入力双方のハイフン有無を吸収するため）
    const qDigits = q.replace(/[^0-9]/g, "");

    // Owner PII 表示権限を事前に取得し、生値表示できるフィールドだけ検索条件に含める。
    // partial / masked / hidden は検索ヒット有無から PII を推測できるため検索対象外。
    const displayConfig = await getOwnerDisplayConfig(session.id);
    const SEARCHABLE_LEVELS = new Set(["edit", "full", "read"]);

    const ownerSearchConditions: object[] = [];
    if (SEARCHABLE_LEVELS.has(displayConfig.name)) {
      ownerSearchConditions.push({ name: { contains: q, mode: "insensitive" } });
    }
    if (SEARCHABLE_LEVELS.has(displayConfig.address)) {
      ownerSearchConditions.push({ address: { contains: q, mode: "insensitive" } });
    }
    if (SEARCHABLE_LEVELS.has(displayConfig.zip)) {
      ownerSearchConditions.push({ zip: { contains: q } });
    }
    // Phone: DB側・入力側両方のハイフン有無を吸収するため regexp_replace で正規化して比較。
    // qDigits が3桁未満は電話番号として非現実的なため実行しない。
    if (SEARCHABLE_LEVELS.has(displayConfig.phone) && qDigits.length >= 3) {
      const phoneOwners = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "owners"
        WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ${"%" + qDigits + "%"}
      `;
      if (phoneOwners.length > 0) {
        ownerSearchConditions.push({ id: { in: phoneOwners.map((r) => r.id) } });
      }
    }

    // 検索可能な Owner フィールドがある場合のみ propertyOwners.some 条件を追加
    const ownerOrCondition =
      ownerSearchConditions.length > 0
        ? [{ propertyOwners: { some: { owner: { OR: ownerSearchConditions } } } }]
        : [];

    // field_staff は自分が作成/担当する物件のみ検索対象にする（AND で scope を強制）
    const fieldStaffScope =
      session.role === "field_staff"
        ? [{ OR: [{ createdBy: session.id }, { assignedTo: session.id }] }]
        : [];

    const properties = await prisma.property.findMany({
      where: {
        isArchived: false,
        AND: [
          ...fieldStaffScope,
          {
            OR: [
              { address: { contains: q, mode: "insensitive" } },
              { lotNumber: { contains: q, mode: "insensitive" } },
              { realEstateNumber: { contains: q, mode: "insensitive" } },
              { buildingNumber: { contains: q, mode: "insensitive" } },
              ...ownerOrCondition,
            ],
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
