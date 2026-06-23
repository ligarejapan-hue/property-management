import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { resolveDraftOptions } from "@/lib/sale-dm-letter/override";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session } = await requireSaleDmAccess();
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    const { id } = await params;
    const draft = await prisma.dmRecipientDraft.findUnique({ where: { id }, include: { variant: true, property: { select: { address: true, propertyType: true, roomNo: true } }, campaign: { select: { createdBy: true } } } });
    // 作成者本人のキャンペーン配下のみ(横断アクセス防止)。not-found/not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    // 送付済み(sent)の宛先は再生成(本文書き換え)できない(送った内容/集計の改竄防止)。
    if (draft.status === "sent") throw new ApiError(409, "送付済みの宛先は再生成できません", "ALREADY_SENT");
    const v = draft.variant;
    const sender = resolveSender();
    const { drafts } = await generateLetters([{
      recipient: {
        representativeName: draft.recipientName, honorific: draft.honorific, coOwnerCount: draft.coOwnerCount,
        propertyAddress: draft.property.address, propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType, roomNo: draft.property.roomNo,
      },
      // 割り当てられた型(variant)の設定に、この通だけの個別上書き(overrideJson)を
      // merge して options を組み立てる(集計は variantId 基準・override は本文の微修正のみ)。
      options: resolveDraftOptions(
        { designTemplate: v.designTemplate, tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength, extraInstruction: v.extraInstruction },
        draft.overrideJson as Parameters<typeof resolveDraftOptions>[1],
        sender,
      ),
    }]);
    const body = drafts[0]?.body;
    if (!body) throw new ApiError(502, "再生成に失敗しました", "GENERATION_FAILED");
    await prisma.dmRecipientDraft.update({ where: { id }, data: { body } });
    return NextResponse.json({ id, body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
