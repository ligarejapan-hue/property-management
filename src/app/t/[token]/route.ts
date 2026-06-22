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

  // 記録は best-effort(失敗しても受け手体験=LP転送を止めない)。
  let matched = false;
  try {
    const r = await recordTrackingHit(prisma, token);
    matched = r.matched;
  } catch {
    // 記録失敗はログのみ(下の 302/404 判定には影響させない)。
    matched = false;
  }

  // AuditLog は非PIIメタのみ。token/氏名/住所は残さない(matched 真偽のみ)。
  await writeAuditLog({
    action: "sale_dm_tracking_hit",
    targetTable: "dm_recipient_drafts",
    detail: { matched, at: new Date().toISOString() },
  });

  // 転送先 LP 未設定なら fail-closed(404)。未知トークンでも、LP 設定済みなら
  // 列挙耐性・受け手体験のため LP へ 302(本文でトークンの有無を示さない)。
  if (!lpUrl) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.redirect(lpUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}
