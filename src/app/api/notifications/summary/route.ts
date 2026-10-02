import { NextRequest, NextResponse } from "next/server";
import { getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { deriveNotificationKeys } from "@/lib/notifications/opaque";
import { buildNotificationSummary } from "@/lib/notifications/summary";

// 通知 段階2: 画面を開いている間に、次回対応・査定申込・謄本の一括取得の完了を知らせるための
// 件数の窓口(設計書 §5.1)。読み取りのみ。件数・不透明な値・時刻だけを返し、PII は返さない。
// 60秒ごとに呼ばれる件数の読み取りなので監査ログには書かない(個人情報を返さないため)。
export async function GET(req: NextRequest) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    const params = new URL(req.url).searchParams;
    const summary = await buildNotificationSummary({
      session: { id: session.id, role: session.role },
      permissions,
      inquiryCursor: params.get("inquiryCursor"),
      registryCursor: params.get("registryCursor"),
      now: new Date(),
      keys: deriveNotificationKeys(),
    });
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
