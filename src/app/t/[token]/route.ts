import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { recordTrackingHit } from "@/lib/sale-dm-letter/tracking-record";
import { isAbsoluteHttpUrl } from "@/lib/sale-dm-letter/tracking";
import { loadSaleDmLpUrl } from "@/lib/sale-dm-letter/config-store";

// 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/t/" を追加済み)。
// 受け手(所有者)は本システムのログインユーザーではないため認証免除が必須。
// no-store: 個人を特定し得る遷移(どの宛先がアクセスしたか)をキャッシュさせない。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // 既定LP は設定(DB→env)から解決する。型ごとLP は recordTrackingHit が返す variantLpUrl が優先。
  // 公開・未認証経路ゆえ LP URL だけを読む専用ローダーを使う(課金APIキーを取得/復号しない)。
  const lpUrl = await loadSaleDmLpUrl();

  // 転送先 LP 未設定なら fail-closed(404)。受け手は LP に到達できないため、トラッキングも
  // 記録しない(到達しない閲覧を反響として A/B に計上しない)。記録より前に判定する。
  if (!lpUrl) {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  // 記録は best-effort(失敗しても受け手体験=LP転送を止めない)。
  // variantLpUrl = 当該宛先の型の LP(型ごとLP振り分け)。未設定/不正値は既定 LP へフォールバック。
  let firstHit = false;
  let variantLpUrl: string | null = null;
  try {
    const r = await recordTrackingHit(prisma, token);
    firstHit = r.firstHit;
    variantLpUrl = r.variantLpUrl;
  } catch {
    // 記録失敗はログのみ(下の 302 判定には影響させない)。
    firstHit = false;
    variantLpUrl = null;
  }

  // 初回ヒットのみ監査する。公開(未認証)エンドポイントゆえ、再訪/クローラ/プレビューや未マッチ/列挙
  // トークンで audit_logs を肥大化させない(2回目以降のアクセスは lpAccessCount で計上済み)。非PIIメタのみ。
  if (firstHit) {
    await writeAuditLog({
      action: "sale_dm_tracking_hit",
      targetTable: "dm_recipient_drafts",
      detail: { firstHit: true, at: new Date().toISOString() },
    });
  }

  // 遷移先: 当該宛先の型に lpUrl があればその型のLPへ(型A→LP1/型B→LP2 の振り分け)、無ければ既定 LP へ。
  // 型の lpUrl が不正(非絶対http)なら既定へフォールバック(保存時に検証済みだが redirect 直前にも防御)。
  // 未知トークンは variantLpUrl=null → 既定 LP へ 302(列挙耐性・本文でトークンの有無を示さない)。
  const target = isAbsoluteHttpUrl(variantLpUrl) ? (variantLpUrl as string) : lpUrl;
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
}
