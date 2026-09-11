import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { clientRateKey, createRateLimiter } from "@/lib/public-rate-limit";

/**
 * LP用写真の公開口(設計 2026-09-08 §2.3)。認証なし。
 *  - publicId(32hex)以外は DB を引かずに 404
 *  - 削除済み・どのLP型からも参照されていない資産は 404(ライブラリに入れただけの写真は出ない)
 *  - Content-Type は保存時の mime 固定・nosniff・長期キャッシュ(内容は不変。差し替えは別の publicId)
 */
const limiter = createRateLimiter({ limit: 300, windowMs: 60_000 }, { onOverflow: "allow" });
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const NOT_FOUND = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  if (!limiter.hit(`lp-asset:${clientRateKey(req.headers)}`)) {
    return new NextResponse(null, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const { publicId } = await params;
  if (!PUBLIC_ID.test(publicId)) return NOT_FOUND();
  const asset = await prisma.dmLpAsset.findUnique({
    where: { publicId },
    select: { storageKey: true, mime: true, deletedAt: true, _count: { select: { media: true } } },
  });
  if (!asset || asset.deletedAt || asset._count.media === 0) return NOT_FOUND();
  const file = await getStorage().read(asset.storageKey);
  if (!file) return NOT_FOUND();
  return new NextResponse(file.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
