import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireDeal } from "@/lib/deals/guard";
import { withDealLock } from "@/lib/deals/schedule-sync";

type Ctx = { params: Promise<{ id: string; linkId: string }> };

/**
 * リンクをいつでも無効にする。届いたファイルと状況は残す。
 * ⚠取引の行を押さえて書く。提出も同じ行を押さえて確かめ直すので、無効にしたあとで提出が通ることがない(@codex #631 P2)。
 */
export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { session } = await requireDeal("write");
    const p = await ctx.params;
    const id = z.string().uuid().parse(p.id);
    const linkId = z.string().uuid().parse(p.linkId);
    const res = await withDealLock(id, (tx) => tx.dealDocLink.updateMany({ where: { id: linkId, dealId: id, revokedAt: null }, data: { revokedAt: new Date() } }));
    if (res.count === 0) throw new ApiError(404, "有効なリンクが見つかりません", "NOT_FOUND");
    await writeAuditLog({ userId: session.id, action: "deal_doc_link_revoke", targetTable: "deals", targetId: id, detail: { count: 1 } });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
