import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, apiResponse } from "@/lib/api-helpers";
import { assertReportInboxAccess, propertyScopeWhere } from "@/lib/report-inbox/access";
import { canAccessPropertyRecord } from "@/lib/property-access";
import { searchPropertiesForReport, type CandidateDb } from "@/lib/report-inbox/candidates";

// ---------- GET /api/report-inbox/search?q= ----------
// 候補に出なかったときに、マンション名・所在地で物件を手で探す(受け取り箱を使える人だけ)。

export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    assertReportInboxAccess(perms);

    const q = request.nextUrl.searchParams.get("q") ?? "";
    const rows = await searchPropertiesForReport(prisma as unknown as CandidateDb, q, propertyScopeWhere(session));
    // 呼び出した人が開ける物件だけ(担当の範囲)。担当者の情報は返さない。
    const data = rows
      .filter((r) => canAccessPropertyRecord(session, { createdBy: r.createdBy ?? "", assignedTo: r.assignedTo ?? null }))
      .map(({ id, address, buildingName, roomNo, propertyType }) => ({ id, address, buildingName, roomNo, propertyType }));
    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
