import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { recordPhoneTap } from "@/lib/sale-dm-letter/phone-tap-record";

// 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/t/" を追加済み)。
// 公開LPの電話ボタン(sendBeacon)からのタップ計測。存在確認・列挙耐性のため常に 204。
// 送付済み(sent)の宛先のみ計上し、初回タップだけ監査する(2回目以降は phoneTapCount で計上済み)。
const tapLimiter = createRateLimiter(
  { limit: 60, windowMs: 60_000 },
  { onOverflow: "allow" },
);

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // 機械的な連打の門前払い(記録より先)。溢れたときは黙って 204(存在・件数を漏らさない)。
  if (!tapLimiter.hit(`t-tap:${clientRateKey(req.headers)}`)) {
    return noContent();
  }
  const { token } = await params;

  const r = await recordPhoneTap(prisma, token);

  // 初回タップのみ監査する(反響ではないため outcome には触れない)。非PIIメタのみ。
  if (r.first && r.draftId) {
    await writeAuditLog({
      action: "sale_dm_lp_phone_tap",
      targetTable: "dm_recipient_drafts",
      targetId: r.draftId,
      detail: { at: new Date().toISOString() },
    });
  }

  return noContent();
}
