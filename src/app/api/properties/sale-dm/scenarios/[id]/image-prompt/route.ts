import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin } from "@/lib/sale-dm-letter/scenario-guard";
import { lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { buildImagePrompt, type ImageSlot } from "@/lib/sale-dm-letter/lp-media";
import { saleDmLpImagePromptQuerySchema } from "@/lib/validators-sale-dm";

/**
 * 台帳の画像の指示文(設計 §2.3/§3.6)。lp-variants/[lpId]/image-prompt と同形。
 * 発送版は宛先で最も多い物件種別を propertyKind に使うが、台帳には宛先が無いので
 * propertyKind は常に null(物件種別を入れない一般的な指示文。buildImagePrompt は null 受け付け済み)。
 * 中身の読み取りは管理者だけ(requireScenarioAdmin)。
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const url = new URL(request.url);
    const q = saleDmLpImagePromptQuerySchema.parse({
      slot: url.searchParams.get("slot") ?? undefined,
      heading: url.searchParams.get("heading") ?? undefined,
      style: url.searchParams.get("style") ?? undefined,
    });
    // lead(リード文)は読まない。プロンプトの材料にしない以上、取り出す必要も無い。
    const s = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null }, select: { lpAppeal: true, lpBodyText: true } });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    if (!s.lpAppeal) throw new ApiError(400, "先にLPの書き方の設定をすべて選んでください", "SCENARIO_SETTINGS_INCOMPLETE");
    let slot: ImageSlot = { kind: "hero" };
    if (q.slot === "section") {
      // 重複の有無に関わらず判定は同じ(見出しの存在確認だけ)だが、他の route と揃えて重複を1件にまとめる。
      const headings = [...new Set(lpBodyHeadings(s.lpBodyText ?? ""))];
      const at = q.heading ? headings.indexOf(q.heading) : -1;
      if (at < 0) throw new ApiError(400, "その小見出しは本文にありません", "HEADING_NOT_FOUND");
      // 見出しの文字はここで捨て、位置(1始まり)と節の総数だけを渡す。
      slot = { kind: "section", index: at + 1, total: headings.length };
    }
    const prompt = buildImagePrompt({ slot, appeal: s.lpAppeal, propertyKind: null, style: q.style });
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_scenario_lp_image_prompt_view",
      targetTable: "dm_scenarios",
      targetId: id,
      detail: { slot: q.slot, viewedAt: new Date().toISOString() },
    });
    return NextResponse.json({ prompt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
