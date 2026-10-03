import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyRecordScopeFilter } from "@/lib/property-record-guard";
import { jstDateToDbDate, jstToday } from "@/lib/notifications/reminder-schedule";

const LIMIT = 50;

// 自分の次回対応(今日・期限切れ)。通知 段階2で「次回対応が N 件あります」を押したときの行き先
// (ホームの一覧・設計書 §2 N4)。条件は次回対応 API と同じ2段: property:read + 物件の担当範囲。
// ⚠自由記述の content は返さない(一覧では予定日・種類・物件の所在だけ。詳しくは物件の画面で)。
export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const scope = propertyRecordScopeFilter(session);
    const todayDb = jstDateToDbDate(jstToday(new Date()));
    const rows = await prisma.nextAction.findMany({
      where: {
        assignedTo: session.id,
        isCompleted: false,
        scheduledAt: { lte: todayDb },
        ...(scope ? { property: scope } : {}),
      },
      orderBy: [{ scheduledAt: "asc" }, { scheduledTime: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      take: LIMIT + 1,
      select: {
        id: true,
        propertyId: true,
        scheduledAt: true,
        scheduledTime: true,
        actionType: true,
        property: { select: { address: true } },
      },
    });
    const items = rows.slice(0, LIMIT).map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      scheduledAt: r.scheduledAt.toISOString().slice(0, 10),
      scheduledTime: r.scheduledTime,
      actionType: r.actionType,
      overdue: r.scheduledAt.getTime() < todayDb.getTime(),
      address: r.property.address,
    }));
    return NextResponse.json({ items, hasMore: rows.length > LIMIT }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
