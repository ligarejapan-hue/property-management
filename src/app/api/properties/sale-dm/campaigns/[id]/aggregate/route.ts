import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess, filterDraftsByFieldStaffScope } from "@/lib/sale-dm-letter/route-guard";
import { aggregateByVariant, aggregateTwoAxis, LP_NONE } from "@/lib/sale-dm-letter/aggregate";
// LP型ごと/組み合わせを出してよいかは公開LPのロールアウトゲートと同じ env で決める(@codex R10 P1)。
// 画面(client)は env を読めないので、判定結果を応答の lpMetricsEnabled に載せて画面へ渡す。
import { isLpMetricsEnabled } from "@/lib/sale-dm-letter/lp-metrics-flag";

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
          // アプリ内ご案内ページを実際に返せた閲覧(LP型ごと/組み合わせの分子)。
          lpPageFirstAt: true,
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
    const lpMetricsEnabled = isLpMetricsEnabled();

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
        // 画面はこの項目だけを見て LP型ごと/組み合わせの表を出す(client は env を読めない)。
        lpMetricsEnabled,
        // LP型ごと/組み合わせは、公開スイッチが入って /t/ が実際にアプリ内ページを出すようになって
        // から返す。スイッチ未投入のうちは全員が同じ外部LPへ飛ぶため、LP型別の「閲覧」は
        // ページの成績ではない(@codex R10 P1)。
        ...(lpMetricsEnabled
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
