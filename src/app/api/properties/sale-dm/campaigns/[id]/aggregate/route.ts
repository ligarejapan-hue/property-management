import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { aggregateByVariant, aggregateTwoAxis, LP_NONE } from "@/lib/sale-dm-letter/aggregate";
// 画面と同じ1か所を見る(@codex R4 P2)。画面だけ隠して API が出し続けると、まだ意味を持たない
// 数字が JSON に載ったまま配られる。
import { LP_METRICS_ENABLED } from "@/lib/sale-dm-letter/lp-metrics-flag";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;

    const campaign = await prisma.dmCampaign.findUnique({
      where: { id },
      select: { id: true, name: true, createdBy: true },
    });
    // 作成者本人のキャンペーンのみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!campaign || campaign.createdBy !== session.id) throw new ApiError(404, "キャンペーンが見つかりません", "NOT_FOUND");

    // 集計入力は反響シグナルの生値から計算する(outcome カラムに依存しない)。
    const [variants, lpVariants, drafts] = await Promise.all([
      prisma.dmVariant.findMany({
        where: { campaignId: id },
        select: { id: true, label: true },
      }),
      prisma.dmLpVariant.findMany({
        where: { campaignId: id },
        select: { id: true, label: true },
      }),
      prisma.dmRecipientDraft.findMany({
        // 送付済み(sent)のみ集計。未送付(draft/confirmed)は配達/反響結果を持てず、送付数の母数に
        // 入れると宛先不明率/反響率を希釈するため除外する(aggregateByVariant は渡された draft を全て sent 計上)。
        where: { campaignId: id, status: "sent" },
        select: {
          variantId: true,
          lpVariantId: true,
          deliveryStatus: true,
          lpFirstAccessAt: true,
          phoneInquiryAt: true,
          phoneTapFirstAt: true,
          property: { select: { createdBy: true, assignedTo: true } },
        },
      }),
    ]);

    // field_staff は作成 or 担当の物件の宛先のみ集計対象(GET campaign/print/export と同じ
    // filterDraftsByFieldStaffScope)。campaign 作成後に物件が別担当へ再割当された宛先の到達/反響/宛先不明数を
    // 混ぜず、可視の宛先リストと指標を一致させる。非 field_staff は全件。
    const visibleDrafts = filterDraftsByFieldStaffScope(drafts, session);
    const aggregate = aggregateByVariant(visibleDrafts);
    const labelByVariantId = new Map(variants.map((v) => [v.id, v.label]));
    // 二軸集計(設計 2026-09-08 §2.1): DM型×LP型の閲覧率。visibleDrafts と同じ scope で計算する。
    const twoAxis = aggregateTwoAxis(visibleDrafts);
    const lpLabel = new Map(lpVariants.map((v) => [v.id, v.label]));

    return NextResponse.json(
      {
        campaignId: campaign.id,
        campaignName: campaign.name,
        byVariant: aggregate.byVariant.map((v) => ({
          ...v,
          label: labelByVariantId.get(v.variantId) ?? v.variantId,
        })),
        total: aggregate.total,
        // DM型ごとの閲覧率は LP の出し分けと無関係(文面の成績)なので常に返す。
        byDmVariantView: twoAxis.byDmVariant.map((v) => ({ ...v, label: labelByVariantId.get(v.variantId) ?? v.variantId })),
        // LP型ごと/組み合わせは /t/ が LP型ごとにページを出し分けるまで返さない。
        ...(LP_METRICS_ENABLED
          ? {
              byLpVariant: twoAxis.byLpVariant.map((v) => ({ ...v, label: v.lpVariantId === LP_NONE ? "LP型なし(外部LP)" : (lpLabel.get(v.lpVariantId) ?? v.lpVariantId) })),
              byPair: twoAxis.byPair.map((p) => ({ ...p, label: `${labelByVariantId.get(p.variantId) ?? p.variantId} × ${p.lpVariantId === LP_NONE ? "LP型なし" : (lpLabel.get(p.lpVariantId) ?? p.lpVariantId)}` })),
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
