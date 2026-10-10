import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, apiResponse } from "@/lib/api-helpers";
import { assertReportInboxAccess } from "@/lib/report-inbox/access";
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
    const rows = await searchPropertiesForReport(prisma as unknown as CandidateDb, q);
    // 念のため担当の範囲も見る(受け取り箱を使える人は通常すべて見られる)。
    const ids = rows.map((r) => r.id);
    const scope = ids.length
      ? await prisma.property.findMany({
          where: { id: { in: ids } },
          select: { id: true, createdBy: true, assignedTo: true },
        })
      : [];
    const allowed = new Set(scope.filter((p) => canAccessPropertyRecord(session, p)).map((p) => p.id));
    return apiResponse({ data: rows.filter((r) => allowed.has(r.id)) });
  } catch (error) {
    return handleApiError(error);
  }
}
