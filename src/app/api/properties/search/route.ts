import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ---------- GET /api/properties/search?q=keyword ----------
// Lightweight search for linking import rows to existing properties.

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

    // ⚠field_staff は自分が作成/担当する物件のみ検索対象にする（担当者スコープ）。
    // 無いと 2 文字のキーワードで担当外物件の住所・地番・不動産番号が列挙できた
    // （認可・PII 横断監査 2026-07-30 の P1）。
    // ⚠**必ず AND で包む**。既存の OR の枝として足すと「キーワード一致 or 自分の物件」
    // になり、スコープが無効化されるどころか全物件が出る（suggest:98 と同じ罠）。
    const fieldStaffScope =
      session.role === "field_staff"
        ? [{ OR: [{ createdBy: session.id }, { assignedTo: session.id }] }]
        : [];

    const properties = await prisma.property.findMany({
      where: {
        AND: [
          ...fieldStaffScope,
          {
            OR: [
              { address: { contains: q, mode: "insensitive" } },
              { lotNumber: { contains: q, mode: "insensitive" } },
              { realEstateNumber: { contains: q, mode: "insensitive" } },
              { externalLinkKey: { contains: q, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        propertyType: true,
        externalLinkKey: true,
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    });

    return apiResponse({ data: properties });
  } catch (error) {
    return handleApiError(error);
  }
}
