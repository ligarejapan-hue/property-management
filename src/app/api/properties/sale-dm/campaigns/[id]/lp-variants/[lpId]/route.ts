import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmLpVariantUpdateSchema } from "@/lib/validators-sale-dm";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";

const OPTION_KEYS = ["tone", "length", "appeal", "strength"] as const;

/**
 * LP型の設定変更(設計 2026-09-08 §2.1/§2.8)。
 * 文体4項目はプロンプトに載るので、実際に変わったら原文・切り分け結果・控えを消す(DM型と同じ)。
 * 送付済みの宛先が1件でもあれば label を含め一切変更不可(DM型と同じ・ラベルは A/B集計・送付履歴に
 * 載るため)。送付済みが無く確定のみの凍結(列 OR 配下に確定)中は文体を変えられない、label だけは通る。
 * LP は印刷物ではないので、DM型の PATCH と違い確定の解除はしない(刷り上がりが変わらない)。
 * ロック順序: dm_lp_variants のみ(dm_variants は触らない)。
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = saleDmLpVariantUpdateSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.dmLpVariant.findFirst({
        where: { id: lpId, campaignId: id },
        select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true },
      });
      if (!existing) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");

      // 送付済みの宛先が使っているLP型は label を含め一切変更不可(DM型と同じ・ラベルは
      // A/B集計・送付履歴に載るため、文体を変えなくても送付後の書き換えは整合を崩す)。
      const sentCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: "sent" },
      });
      if (sentCount > 0) {
        throw new ApiError(
          409,
          "送付済みの宛先があるLP型は設定を変更できません(A/B履歴の整合のため)",
          "VARIANT_LOCKED",
        );
      }

      const data: Prisma.DmLpVariantUpdateInput = {};
      if (parsed.label !== undefined) data.label = parsed.label;
      let optionFieldChanged = false;
      if (parsed.options) {
        for (const k of OPTION_KEYS) {
          const v = parsed.options[k];
          if (v === undefined) continue;
          data[k] = v;
          if (v !== existing[k]) optionFieldChanged = true;
        }
      }
      if (optionFieldChanged) {
        const settledCount = await tx.dmRecipientDraft.count({
          where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
        });
        if (isVariantFrozen({ templateFrozenAt: existing.templateFrozenAt, settledCount })) {
          throw new ApiError(
            409,
            "送付実績のあるLP型の文面の設定(トーン・長さ・訴求・押しの強さ)は変更できません。文面を変えるときは新しいLP型を追加してください",
            "VARIANT_LOCKED",
          );
        }
        // 古いプロンプトで作った文章を新しい設定の型として使えないよう、原文・切り分け結果・控えを消す。
        data.promptText = null;
        data.rawTemplate = null;
        data.headline = null;
        data.lead = null;
        data.bodyText = null;
        data.faqJson = Prisma.DbNull;
      }
      return tx.dmLpVariant.update({ where: { id: lpId, campaignId: id }, data });
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_update",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, fields: Object.keys(parsed), updatedAt: new Date().toISOString() },
    });
    return NextResponse.json({ lpVariant: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);

    const deleted = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const row = await tx.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { templateFrozenAt: true } });
      if (!row) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      if (isVariantFrozen({ templateFrozenAt: row.templateFrozenAt, settledCount })) {
        throw new ApiError(409, "送付実績のあるLP型は削除できません", "VARIANT_FROZEN");
      }
      // 宛先を1件も持たない場合のみ削除(count→delete の隙間を作らない)。
      return tx.dmLpVariant.deleteMany({ where: { id: lpId, campaignId: id, recipients: { none: {} } } });
    });
    if (deleted.count === 0) throw new ApiError(409, "このLP型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_delete",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, deletedAt: new Date().toISOString() },
    });
    return NextResponse.json({ deleted: lpId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
