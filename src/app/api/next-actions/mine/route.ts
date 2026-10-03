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
    // field_staff は物件の担当範囲(作成 or 担当)だけ。propertyRecordScopeFilter と同じ定義。
    const scopeUserId = propertyRecordScopeFilter(session) ? session.id : null;
    const now = new Date();
    const todayDb = jstDateToDbDate(jstToday(now));
    const tomorrowDb = new Date(todayDb.getTime() + 24 * 60 * 60 * 1000);
    // 並びは「予定日 → その日の期限の時刻(時刻なしは 9:00=知らせを出す時刻と同じ) → id」。
    // Prisma の orderBy では「時刻なし=9:00」と並べられないため SQL で並べる(@codex #470 P2:
    // 時刻なしを先頭に置くと、0:30・8:00 の予定が後ろに回り、50件で切ると落ちることがあった)。
    const rows = await prisma.$queryRaw<
      Array<{ id: string; property_id: string; scheduled_at: Date; scheduled_time: string | null; action_type: string | null; address: string | null }>
    >`
      SELECT na."id", na."property_id", na."scheduled_at", na."scheduled_time", na."action_type", p."address"
      FROM "next_actions" na
      JOIN "properties" p ON p."id" = na."property_id"
      WHERE na."assigned_to" = ${session.id}::uuid
        AND na."is_completed" = false
        AND (
          na."scheduled_at" <= ${todayDb}::date
          -- 明日 0:00〜0:04 の予定は、5分前の知らせが今日の夜に出る。押して開いたこの一覧に
          -- その予定が無いと困るので、知らせの時刻(期限の5分前)を過ぎていれば含める(@codex #470 P2)。
          OR (
            na."scheduled_at" = ${tomorrowDb}::date
            AND na."scheduled_time" IS NOT NULL
            AND ((na."scheduled_at" + na."scheduled_time"::time) AT TIME ZONE 'Asia/Tokyo') - INTERVAL '5 minutes' <= ${now}::timestamptz
          )
        )
        AND (${scopeUserId}::uuid IS NULL OR p."created_by" = ${scopeUserId}::uuid OR p."assigned_to" = ${scopeUserId}::uuid)
      ORDER BY na."scheduled_at" ASC, COALESCE(na."scheduled_time", '09:00') ASC, na."id" ASC
      LIMIT ${LIMIT + 1}
    `;
    const items = rows.slice(0, LIMIT).map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      scheduledAt: r.scheduled_at.toISOString().slice(0, 10),
      scheduledTime: r.scheduled_time,
      actionType: r.action_type,
      overdue: r.scheduled_at.getTime() < todayDb.getTime(),
      tomorrow: r.scheduled_at.getTime() > todayDb.getTime(),
      address: r.address,
    }));
    return NextResponse.json({ items, hasMore: rows.length > LIMIT }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
