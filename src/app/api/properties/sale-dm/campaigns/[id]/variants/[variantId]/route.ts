import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { saleDmVariantUpdateSchema } from "@/lib/validators-sale-dm";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ更新可。
    const parsed = saleDmVariantUpdateSchema.parse(await parseJsonBody(request));

    // 当該キャンペーンに存在する型のみ更新可。stale/削除済み id は Prisma P2025→500 でなく 404 に。
    const exists = await prisma.dmVariant.findFirst({ where: { id: variantId, campaignId: id }, select: { id: true } });
    if (!exists) {
      throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
    }

    // 送付済みの宛先が使っている型は設定変更不可。送付後に設計/トーン/訴求やラベルを
    // 変えると、CSV・送付履歴・A/B 集計が実際に送った構成と食い違うため凍結する。
    const sentCount = await prisma.dmRecipientDraft.count({
      where: { campaignId: id, variantId, status: "sent" },
    });
    if (sentCount > 0) {
      throw new ApiError(409, "送付済みの宛先がある型は設定を変更できません(A/B履歴の整合のため)", "VARIANT_LOCKED");
    }

    const data: Prisma.DmVariantUpdateInput = {};
    if (parsed.label !== undefined) data.label = parsed.label;
    if (parsed.options) {
      const o = parsed.options;
      if (o.designTemplate !== undefined) data.designTemplate = o.designTemplate;
      if (o.tone !== undefined) data.tone = o.tone;
      if (o.length !== undefined) data.length = o.length;
      if (o.appeal !== undefined) data.appeal = o.appeal;
      if (o.strength !== undefined) data.strength = o.strength;
      if (o.extraInstruction !== undefined) data.extraInstruction = o.extraInstruction ?? null;
    }

    // campaignId で縛り、他キャンペーンの型を更新させない。
    const result = await prisma.dmVariant.update({
      where: { id: variantId, campaignId: id },
      data,
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_update",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ variant: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; variantId: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id); // 作成者本人のキャンペーンの型のみ削除可。

    // 当該キャンペーンに存在する型のみ削除可。stale/削除済み id は Prisma P2025→500 でなく 404 に。
    const exists = await prisma.dmVariant.findFirst({ where: { id: variantId, campaignId: id }, select: { id: true } });
    if (!exists) {
      throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
    }

    // A/B 純度: 割当済みの下書きがある型は削除できない(別型へ移してから)。
    const inUse = await prisma.dmRecipientDraft.count({ where: { campaignId: id, variantId } });
    if (inUse > 0) {
      throw new ApiError(409, "この型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");
    }

    await prisma.dmVariant.delete({ where: { id: variantId, campaignId: id } });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_variant_delete",
      targetTable: "dm_variants",
      targetId: variantId,
      detail: { campaignId: id, deletedAt: new Date().toISOString() },
    });

    return NextResponse.json({ deleted: variantId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
