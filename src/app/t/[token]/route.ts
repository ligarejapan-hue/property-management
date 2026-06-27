import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { recordTrackingHit } from "@/lib/sale-dm-letter/tracking-record";

// 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/t/" を追加済み)。
// 受け手(所有者)は本システムのログインユーザーではないため認証免除が必須。
// no-store: 個人を特定し得る遷移(どの宛先がアクセスしたか)をキャッシュさせない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const lpUrl = process.env.SALE_DM_LP_URL;

  // 転送先 LP 未設定なら fail-closed(404)。受け手は LP に到達できないため、トラッキングも
  // 記録しない(到達しない閲覧を反響として A/B に計上しない)。記録より前に判定する。
  if (!lpUrl) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  // 記録は best-effort(失敗しても受け手体験=LP転送を止めない)。
  let matched = false;
  try {
    const r = await recordTrackingHit(prisma, token);
    matched = r.matched;
  } catch {
    // 記録失敗はログのみ(下の 302 判定には影響させない)。
    matched = false;
  }

  // マッチした実ヒットのみ監査する。未認証の公開エンドポイントゆえ、未マッチ/bot/
  // 列挙トークンで audit_logs を肥大化させない(書込増幅の防止)。非PIIメタのみ。
  if (matched) {
    await writeAuditLog({
      action: "sale_dm_tracking_hit",
      targetTable: "dm_recipient_drafts",
      detail: { matched: true, at: new Date().toISOString() },
    });
  }

  // 未知トークンでも、LP 設定済みなら列挙耐性・受け手体験のため LP へ 302(本文でトークンの有無を示さない)。
  return NextResponse.redirect(lpUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}
