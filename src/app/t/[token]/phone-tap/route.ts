import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { recordPhoneTap } from "@/lib/sale-dm-letter/phone-tap-record";

// 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/t/" を追加済み)。
// 公開LPの電話ボタン(sendBeacon)からのタップ計測。存在確認・列挙耐性のため常に 204。
// 送付済み(sent)の宛先のみ計上し、初回タップだけ監査する(2回目以降は phoneTapCount で計上済み)。
// ⚠public-rate-limit.ts の「書き込み系は deny」規約に対する意図的な例外: 429 はトークンの
// 有効性を応答で漏らすオラクルになり得る一方、副作用は1カウンタ+draftごと最大1監査行に
// 限定され被害が小さいため、ここは読み取り系と同じ onOverflow:"allow"(黙って204)にしている。
const tapLimiter = createRateLimiter(
  { limit: 60, windowMs: 60_000 },
  { onOverflow: "allow" },
);

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** よそのサイトに置かれたページからの送信かどうかの判定。
 *  Origin ヘッダが付いていて、その相手先が自分自身でなければ「よそから」= 数えない。
 *  Origin が無いとき(sendBeacon の一部経路など)は従来どおり通す
 *  = 本物のタップを取りこぼさない方を優先する。
 *  ⚠弾くときも応答は同じ 204(no-store)のまま。ここで 403 を返すと
 *    「弾かれた=そのURLは実在する」という手掛かりになってしまう(列挙耐性)。 */
function isForeignOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // URL として読めない Origin は自分自身ではない。
  }
  return originHost !== new URL(req.url).host;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  // よそのサイトからの送信は数えない(応答は同じ 204)。判定はDBに触る前に済ませる。
  if (isForeignOrigin(req)) {
    return noContent();
  }
  // 機械的な連打の門前払い(記録より先)。溢れたときは黙って 204(存在・件数を漏らさない)。
  if (!tapLimiter.hit(`t-tap:${clientRateKey(req.headers)}`)) {
    return noContent();
  }
  const { token } = await params;

  // recordPhoneTap 自体は内部で例外を握って matched:false を返す契約だが、想定外の失敗
  // (呼び出し自体が投げる等)でも公開 POST の「常に 204」を絶対に崩さないよう、
  // ここでも念のため握る(/t/[token]/route.ts の recordTrackingHit 呼び出しに倣う)。
  let r: Awaited<ReturnType<typeof recordPhoneTap>> = { matched: false, first: false };
  try {
    r = await recordPhoneTap(prisma, token);
  } catch {
    r = { matched: false, first: false };
  }

  // 初回タップのみ監査する(反響ではないため outcome には触れない)。非PIIメタのみ。
  if (r.matched && r.first) {
    await writeAuditLog({
      action: "sale_dm_lp_phone_tap",
      targetTable: "dm_recipient_drafts",
      targetId: r.draftId,
      detail: { at: new Date().toISOString() },
    });
  }

  return noContent();
}
