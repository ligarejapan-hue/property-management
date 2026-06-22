import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { isSaleDmConfigured, generateLetters } from "@/lib/sale-dm-letter";
import { resolveSender } from "@/lib/sale-dm-letter/sender";
import { PROPERTY_TYPE_LABELS } from "@/lib/property-types";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSaleDmAccess();
    if (!isSaleDmConfigured()) throw new ApiError(503, "売却DM生成が未設定です", "NOT_CONFIGURED");
    const { id } = await params;
    const draft = await prisma.dmRecipientDraft.findUnique({ where: { id }, include: { variant: true, property: { select: { address: true, propertyType: true, roomNo: true } } } });
    if (!draft) throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    const v = draft.variant;
    const sender = resolveSender();
    const { drafts } = await generateLetters([{
      recipient: {
        representativeName: draft.recipientName, honorific: draft.honorific, coOwnerCount: draft.coOwnerCount,
        propertyAddress: draft.property.address, propertyTypeLabel: PROPERTY_TYPE_LABELS[draft.property.propertyType] ?? draft.property.propertyType, roomNo: draft.property.roomNo,
      },
      options: { designTemplate: v.designTemplate, tone: v.tone, length: v.length, appeal: v.appeal, strength: v.strength, senderName: sender.senderName, senderContact: sender.senderContact, extraInstruction: v.extraInstruction ?? undefined },
    }]);
    const body = drafts[0]?.body;
    if (!body) throw new ApiError(502, "再生成に失敗しました", "GENERATION_FAILED");
    await prisma.dmRecipientDraft.update({ where: { id }, data: { body } });
    return NextResponse.json({ id, body }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
