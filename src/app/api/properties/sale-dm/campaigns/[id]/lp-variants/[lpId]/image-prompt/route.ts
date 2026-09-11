import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { buildImagePrompt, type ImageSlot } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpImagePromptQuerySchema } from "@/lib/validators-sale-dm";

/**
 * 生成AI(画像)向けプロンプト(設計 §2.3)。材料は LP型の設定(訴求)・宛先で最も多い物件種別・
 * 枠の位置(何番目の節か)だけ。
 * ⚠**貼り付けられた自由文(リード文・小見出し・本文)は一切渡さない**(@codex R1 P1・ruling R8(b))。
 * 画面は今までどおり小見出しの文字列を `heading` として送るが、ここで**本文の何番目の節か**に
 * 変換してから buildImagePrompt に渡す。見出しの文字もリード文も buildImagePrompt の引数に無いので、
 * 氏名・住所が紛れ込む口が構造として存在しない。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const url = new URL(request.url);
    const q = saleDmLpImagePromptQuerySchema.parse({
      slot: url.searchParams.get("slot") ?? undefined,
      heading: url.searchParams.get("heading") ?? undefined,
      style: url.searchParams.get("style") ?? undefined,
    });
    // lead(リード文)は読まない。プロンプトの材料にしない以上、取り出す必要も無い。
    const v = await prisma.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { appeal: true, bodyText: true } });
    if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
    let slot: ImageSlot = { kind: "hero" };
    if (q.slot === "section") {
      // 重複の有無に関わらず判定は同じ(見出しの存在確認だけ)だが、他の route と揃えて重複を1件にまとめる。
      const headings = [...new Set(lpBodyHeadings(v.bodyText ?? ""))];
      const at = q.heading ? headings.indexOf(q.heading) : -1;
      if (at < 0) throw new ApiError(400, "その小見出しは本文にありません", "HEADING_NOT_FOUND");
      // 見出しの文字はここで捨て、位置(1始まり)と節の総数だけを渡す。
      slot = { kind: "section", index: at + 1, total: headings.length };
    }
    // 宛先で最も多い種別(種別は文面の差し込みにも使う非PII)。relation 名は schema の DmRecipientDraft.property を確認して合わせる。
    const kinds = await prisma.dmRecipientDraft.findMany({ where: { campaignId: id }, select: { property: { select: { propertyType: true } } }, take: 500 });
    const tally = new Map<string, number>();
    for (const k of kinds) { const t = k.property?.propertyType; if (t) tally.set(t, (tally.get(t) ?? 0) + 1); }
    const propertyKind = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const prompt = buildImagePrompt({ slot, appeal: v.appeal, propertyKind, style: q.style });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_image_prompt_view",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, slot: q.slot, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ prompt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
