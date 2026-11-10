import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyRecordScopeFilter } from "@/lib/property-record-guard";
import { nextActionDeadline, isTimedNextAction } from "@/lib/notifications/reminder-schedule";
import { townOnly } from "@/lib/agent-inquiry/desk-property";
import { VIEWING_TYPE_LABEL } from "@/lib/agent-inquiry/desk-form";
import { dealTitle } from "@/lib/deals/deal-title";
import {
  addDaysYmd, isYmd, jstDateTime, jstTodayYmd, weekRangeUtc, weekStartOf, type WeekItem, type WeekResponse,
} from "@/lib/home/week";

/** 種類ごとの上限(1週間分なので通常は届かない)。 */
const LIMIT = 200;

type Snapshot = { buildingName: string | null; roomNo: string | null; address: string | null };
const snapshotOf = (v: unknown): Snapshot => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { buildingName: null, roomNo: null, address: null };
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  return { buildingName: s("buildingName"), roomNo: s("roomNo"), address: s("address") };
};

/**
 * ホームの「今週の予定」(2026-11-10 案4)。見るだけ。
 * - 次回対応: property:read + 物件の担当範囲(field_staff)。未完了だけ。自由記述の content は返さない。
 * - 内見: agent_inquiry:read。取り消し・日程調整中(日時なし)は出さない。業者・連絡先は返さない。
 * - 契約・決済: deal:read。中止の取引は出さない。
 * 権限が無い種類は空で返す(全体は 403 にしない)。scope=all は管理者だけ(それ以外は 403)。
 * 「自分」= 次回対応は自分が担当、内見は自分が立会い、取引は担当者・営業・業務・宅建士のどれか。
 */
export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    const url = new URL(request.url);
    const scopeParam = url.searchParams.get("scope") ?? "mine";
    if (scopeParam !== "mine" && scopeParam !== "all") {
      throw new ApiError(422, "表示の範囲が正しくありません", "VALIDATION_ERROR");
    }
    const canSeeAll = session.role === "admin";
    if (scopeParam === "all" && !canSeeAll) {
      throw new ApiError(403, "全員の予定を見る権限がありません", "FORBIDDEN");
    }
    const all = scopeParam === "all";
    const now = new Date();
    const today = jstTodayYmd(now);
    const weekParam = url.searchParams.get("week");
    if (weekParam !== null && !isYmd(weekParam)) {
      throw new ApiError(422, "週の指定が正しくありません", "VALIDATION_ERROR");
    }
    const weekStart = weekStartOf(weekParam ?? today);
    const weekEnd = addDaysYmd(weekStart, 6);
    const { from, to } = weekRangeUtc(weekStart);

    const perms = await getUserPermissions(session.id);
    const canNext = hasPermission(perms, "property", "read");
    const canViewing = hasPermission(perms, "agent_inquiry", "read");
    const canDeal = hasPermission(perms, "deal", "read");
    const propScope = propertyRecordScopeFilter(session);

    const [nextActions, viewings, deals] = await Promise.all([
      canNext
        ? prisma.nextAction.findMany({
            where: {
              isCompleted: false,
              scheduledAt: { gte: new Date(`${weekStart}T00:00:00.000Z`), lte: new Date(`${weekEnd}T00:00:00.000Z`) },
              ...(all ? {} : { assignedTo: session.id }),
              ...(propScope ? { property: propScope } : {}),
            },
            orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
            take: LIMIT + 1,
            select: {
              id: true, propertyId: true, scheduledAt: true, scheduledTime: true, actionType: true,
              property: { select: { address: true } },
              assignee: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
      canViewing
        ? prisma.agentViewing.findMany({
            where: {
              canceledAt: null,
              scheduledAt: { gte: from, lt: to },
              ...(all ? {} : { attendantId: session.id }),
            },
            orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
            take: LIMIT + 1,
            select: {
              id: true, scheduledAt: true, viewingType: true,
              attendant: { select: { name: true } },
              inquiry: { select: { property: { select: { address: true, buildingName: true, roomNo: true, building: { select: { name: true } } } } } },
            },
          })
        : Promise.resolve([]),
      canDeal
        ? prisma.deal.findMany({
            where: {
              status: { not: "cancelled" },
              AND: [
                { OR: [{ contractAt: { gte: from, lt: to } }, { settlementAt: { gte: from, lt: to } }] },
                ...(all
                  ? []
                  : [{ OR: [
                      { assigneeId: session.id }, { salesStaffId: session.id },
                      { opsStaffId: session.id }, { licensedAgentId: session.id },
                    ] }]),
              ],
            },
            orderBy: [{ id: "asc" }],
            take: LIMIT + 1,
            select: {
              id: true, dealNo: true, name: true, contractAt: true, settlementAt: true, propertySnapshot: true,
              assignee: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const items: WeekItem[] = [];
    for (const a of nextActions.slice(0, LIMIT)) {
      const timed = isTimedNextAction(a.scheduledTime);
      items.push({
        key: `na:${a.id}`, kind: "next_action",
        date: a.scheduledAt.toISOString().slice(0, 10),
        time: timed ? a.scheduledTime : null,
        title: a.property?.address || "（所在なし）",
        sub: a.actionType, who: all ? (a.assignee?.name ?? null) : null,
        href: `/properties/${a.propertyId}`, desk: false,
        // 物件の次回対応タブ・/mine と同じ: 時刻ありはその時刻、時刻なしは予定日が今日より前なら期限切れ。
        overdue: timed
          ? nextActionDeadline(a.scheduledAt, a.scheduledTime) < now.getTime()
          : a.scheduledAt.toISOString().slice(0, 10) < today,
      });
    }
    for (const v of viewings.slice(0, LIMIT)) {
      if (!v.scheduledAt) continue;
      const p = v.inquiry.property;
      const { date, time } = jstDateTime(v.scheduledAt);
      items.push({
        key: `vw:${v.id}`, kind: "viewing", date, time,
        // 受付の窓と同じ見せ方(建物名、無ければ町名まで)。
        title: p.building?.name || p.buildingName || townOnly(p.address ?? "") || "（所在なし）",
        sub: VIEWING_TYPE_LABEL[v.viewingType as keyof typeof VIEWING_TYPE_LABEL] ?? null,
        who: all ? (v.attendant?.name ?? null) : null,
        href: "/inquiry-desk", desk: true, overdue: false,
      });
    }
    for (const d of deals.slice(0, LIMIT)) {
      const title = dealTitle({ name: d.name, propertySnapshot: snapshotOf(d.propertySnapshot) });
      for (const [kind, at] of [["contract", d.contractAt], ["settlement", d.settlementAt]] as const) {
        if (!at || at < from || at >= to) continue;
        const { date, time } = jstDateTime(at);
        items.push({
          key: `${kind}:${d.id}`, kind, date, time, title, sub: d.dealNo,
          who: all ? (d.assignee?.name ?? null) : null,
          href: `/deals/${d.id}`, desk: false, overdue: false,
        });
      }
    }

    const body: WeekResponse = {
      weekStart, scope: all ? "all" : "mine", canSeeAll, items,
      hasMore: nextActions.length > LIMIT || viewings.length > LIMIT || deals.length > LIMIT,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
