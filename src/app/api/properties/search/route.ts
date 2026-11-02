import { containsVariants } from "@/lib/notation";
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
import { CASE_STATUS_VALUES } from "@/lib/property-types";

// ---------- GET /api/properties/search?q=keyword[&caseStatus=contract_planned] ----------
// Lightweight search for linking import rows to existing properties.
// caseStatus を付けたときは「その案件状況の物件だけ」に絞る(取引の新規作成で物件を選ぶ用)。
//   このときは q が空でもよい(空なら案件状況だけで一覧)。アーカイブ済みは出さない。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);

    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }

    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const caseStatusParam = request.nextUrl.searchParams.get("caseStatus");
    const caseStatus =
      caseStatusParam && (CASE_STATUS_VALUES as readonly string[]).includes(caseStatusParam)
        ? (caseStatusParam as (typeof CASE_STATUS_VALUES)[number])
        : null;
    if (caseStatusParam && !caseStatus) {
      throw new ApiError(400, "案件状況の指定が正しくありません", "VALIDATION_ERROR");
    }
    // 案件状況の指定がないときは従来どおり 2 文字未満は空(取込の紐付けの動き)。
    // 指定があるときは、空なら案件状況だけで一覧、1 文字は空(打ちかけ)。
    if (caseStatus ? q.length === 1 : q.length < 2) {
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
          ...(caseStatus ? [{ caseStatus, isArchived: false }] : []),
          ...(q
            ? [
                {
                  OR: [
                    ...containsVariants("address", q, "insensitive"),
                    ...containsVariants("lotNumber", q, "insensitive"),
                    { realEstateNumber: { contains: q, mode: "insensitive" as const } },
                    { externalLinkKey: { contains: q, mode: "insensitive" as const } },
                    ...containsVariants("buildingName", q, "insensitive"),
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        address: true,
        lotNumber: true,
        realEstateNumber: true,
        propertyType: true,
        externalLinkKey: true,
        buildingName: true,
        roomNo: true,
        caseStatus: true,
      },
      take: caseStatus ? 30 : 10,
      orderBy: { updatedAt: "desc" },
    });

    return apiResponse({ data: properties });
  } catch (error) {
    return handleApiError(error);
  }
}
