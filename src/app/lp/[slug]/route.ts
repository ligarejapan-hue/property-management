import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";
import { loadPublicLpPage } from "@/lib/sale-dm-letter/lp-public-loader";

/**
 * 広告用の公開ページ(設計 docs/superpowers/specs/2026-10-20-lp-public-page-design.md §1)。
 * 認証不要の公開エンドポイント(proxy.ts の PUBLIC_PATHS に "/lp/"・公開ホストの nginx に location ^~ /lp/)。
 *  - 宛先を持たない=誰が開いたかは記録しない(閲覧の集計は Google 側)。監査も書かない(公開・高頻度)。
 *  - 出す条件(公開ゲート・公開名・「使う」・文章あり)はすべて loadPublicLpPage。満たさなければ 404(中身の有無を漏らさない)。
 *  - 回数制限は /t/ と同じ尽力ベース(60/分)。溢れたときは通す=正規の訪問者を巻き込まない。
 *  - URL の utm_* / gclid はページの隠し欄に写す(申込と一緒に保存)。
 */
const pageLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 }, { onOverflow: "allow" });

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  if (!pageLimiter.hit(`lp-get:${clientRateKey(req.headers)}`)) {
    return new NextResponse(null, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const { slug } = await params;
  const query = new URL(req.url).searchParams;
  let page: Awaited<ReturnType<typeof loadPublicLpPage>>;
  try {
    page = await loadPublicLpPage(prisma, slug, (k) => query.get(k));
  } catch (err) {
    // DB 障害などの一時的な失敗は 404 にしない(検索に載せるページ=404 を返すと消されたと解釈され得る・@codex #535 R3 P2)。
    console.error("[lp_public_page] load failed", { name: err instanceof Error ? err.name : "Unknown" });
    return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
  if (page.kind !== "page") {
    return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse(page.html, { status: 200, headers: { ...page.headers } });
}
