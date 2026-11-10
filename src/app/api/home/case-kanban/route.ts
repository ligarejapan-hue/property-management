import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyVisibilityScopeWhere } from "@/lib/property-list-query";
import {
  KANBAN_CARD_LIMIT, KANBAN_STATUSES, kanbanLabel, type KanbanResponse, type KanbanStatus,
} from "@/lib/home/case-kanban";

/**
 * ホームの「案件の進み具合」(2026-11-10 案2)。見るだけ。
 * 権限は物件一覧と同じ: property:read + 見える範囲(field_staff は作成 or 担当)。保存済み(アーカイブ)は数えない。
 * mine=1 で自分が担当の物件だけ。カードは所在・担当者の表示名・最終更新だけ(所有者・座標は返さない)。
 */
export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const mine = new URL(request.url).searchParams.get("mine") === "1";
    const scope = propertyVisibilityScopeWhere(session);
    const base = {
      isArchived: false,
      ...(scope ? { AND: [scope] } : {}),
      ...(mine ? { assignedTo: session.id } : {}),
    };
    const [groups, cardLists] = await Promise.all([
      prisma.property.groupBy({
        by: ["caseStatus"],
        where: { ...base, caseStatus: { in: [...KANBAN_STATUSES] } },
        _count: { _all: true },
      }),
      Promise.all(
        KANBAN_STATUSES.map((status) =>
          prisma.property.findMany({
            where: { ...base, caseStatus: status },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take: KANBAN_CARD_LIMIT,
            select: { id: true, address: true, updatedAt: true, assignee: { select: { name: true } } },
          }),
        ),
      ),
    ]);
    const countOf = new Map<string, number>(groups.map((g: { caseStatus: string; _count: { _all: number } }) => [g.caseStatus, g._count._all]));
    const body: KanbanResponse = {
      mine,
      selfId: session.id,
      columns: KANBAN_STATUSES.map((status: KanbanStatus, i) => ({
        status,
        label: kanbanLabel(status),
        count: countOf.get(status) ?? 0,
        cards: cardLists[i].map((p: { id: string; address: string | null; updatedAt: Date; assignee: { name: string } | null }) => ({
          id: p.id,
          address: p.address || null,
          assigneeName: p.assignee?.name ?? null,
          updatedAt: p.updatedAt.toISOString(),
        })),
      })),
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
