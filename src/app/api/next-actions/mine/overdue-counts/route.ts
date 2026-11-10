import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, handleApiError, ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { propertyRecordScopeFilter } from "@/lib/property-record-guard";
import { jstToday } from "@/lib/notifications/reminder-schedule";

// 自分の期限切れの次回対応の件数(ホームの重要指標・2026-11-10)。件数と経過日数の内訳だけを返す。
// 条件は /api/next-actions/mine と同じ: property:read + 物件の担当範囲(field_staff は作成 or 担当)。
// 期限切れの判定も同じ: 時刻ありはその時刻(日本時間)を過ぎたら、時刻なしは予定日が今日より前なら。
// 経過日数=日本時間の今日 − 予定日(時刻ありで今日のうちに過ぎたものは 0 日=「3日以内」)。
export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const scopeUserId = propertyRecordScopeFilter(session) ? session.id : null;
    const now = new Date();
    // ⚠SQL には Date ではなく文字列で束縛する(/mine と同じ理由・@codex #470 P2)。
    const todayYmd = jstToday(now);
    const nowIso = now.toISOString();
    const rows = await prisma.$queryRaw<Array<{ total: number; within3: number; within7: number; older: number }>>`
      WITH od AS (
        SELECT (${todayYmd}::date - na."scheduled_at") AS days
        FROM "next_actions" na
        JOIN "properties" p ON p."id" = na."property_id"
        WHERE na."assigned_to" = ${session.id}::uuid
          AND na."is_completed" = false
          AND (
            (na."scheduled_time" IS NULL AND na."scheduled_at" < ${todayYmd}::date)
            OR (
              na."scheduled_time" IS NOT NULL
              AND ((na."scheduled_at" + na."scheduled_time"::time) AT TIME ZONE 'Asia/Tokyo') < ${nowIso}::timestamptz
            )
          )
          AND (${scopeUserId}::uuid IS NULL OR p."created_by" = ${scopeUserId}::uuid OR p."assigned_to" = ${scopeUserId}::uuid)
      )
      SELECT
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE days <= 3))::int AS within3,
        (COUNT(*) FILTER (WHERE days BETWEEN 4 AND 7))::int AS within7,
        (COUNT(*) FILTER (WHERE days >= 8))::int AS older
      FROM od
    `;
    const r = rows[0];
    const n = (v: unknown) => Number(v ?? 0);
    return NextResponse.json(
      { total: n(r?.total), within3: n(r?.within3), within7: n(r?.within7), older: n(r?.older) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
