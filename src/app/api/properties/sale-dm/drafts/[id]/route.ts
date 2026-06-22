import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { saleDmOptionsOverrideSchema } from "@/lib/validators-sale-dm";

// body / variantId / override の部分更新。最低1フィールドは必須。
const patchSchema = z
  .object({
    body: z.string().min(1).optional(),
    variantId: z.string().uuid().optional(),
    override: saleDmOptionsOverrideSchema.nullable().optional(),
  })
  .refine(
    (v) => v.body !== undefined || v.variantId !== undefined || v.override !== undefined,
    { message: "更新する項目がありません(body / variantId / override のいずれかが必要です)" },
  );

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const parsed = patchSchema.parse(await parseJsonBody(request));

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: { id: true, campaignId: true },
    });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = {};

    if (parsed.body !== undefined) data.body = parsed.body;

    if (parsed.variantId !== undefined) {
      // 付け替え先は同一 campaign の型に限る(他キャンペーンの型を割り当てさせない)。
      const variant = await prisma.dmVariant.findFirst({
        where: { id: parsed.variantId, campaignId: draft.campaignId },
        select: { id: true },
      });
      if (!variant) throw new ApiError(404, "指定された型が見つかりません", "VARIANT_NOT_FOUND");
      data.variantId = parsed.variantId;
    }

    // override は明示 null で消去、object で保存。undefined は不変。
    if (parsed.override !== undefined) data.overrideJson = parsed.override;


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updated = await prisma.dmRecipientDraft.update({ where: { id }, data: data as any });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      // 非PII: 何を更新したかのキー名のみ(本文・override 内容は残さない)。
      detail: { campaignId: draft.campaignId, fields: Object.keys(data), updatedAt: new Date().toISOString() },
    });

    return NextResponse.json({ id: updated.id }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
