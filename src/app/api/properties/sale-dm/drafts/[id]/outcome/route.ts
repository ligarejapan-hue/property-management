import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { writeAuditLog } from "@/lib/audit";
import { deriveOutcome } from "@/lib/sale-dm-letter/outcome";

// 配達結果は明示指定された時のみ更新する(省略時は据え置き)。
// 反響(電話)は true/false で立て下げ可能にする(取り消し時は LP の有無で再導出)。
const outcomeSchema = z
  .object({
    deliveryStatus: z
      .enum(["unknown", "delivered", "returned_undeliverable", "returned_other"])
      .optional(),
    phoneInquiry: z.boolean().optional(),
    outcomeNote: z.string().max(2000).optional(),
  })
  .refine(
    (b) =>
      b.deliveryStatus !== undefined ||
      b.phoneInquiry !== undefined ||
      b.outcomeNote !== undefined,
    { message: "更新内容がありません" },
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { session } = await requireSaleDmAccess();
    const { id } = await params;
    const input = outcomeSchema.parse(await request.json());

    const draft = await prisma.dmRecipientDraft.findUnique({
      where: { id },
      select: {
        id: true,
        propertyId: true,
        deliveryStatus: true,
        lpFirstAccessAt: true,
        phoneInquiryAt: true,
        status: true,
        campaign: { select: { createdBy: true } },
      },
    });
    // 作成者本人のキャンペーン配下の下書きのみ操作可(他人UUIDでの横断アクセス防止)。
    // 存在を漏らさないため not-found / not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) {
      throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    }
    // 配達結果/反響は送付済み(sent)の宛先にのみ記録できる(未送付物件を no_send に汚染しない)。
    if (draft.status !== "sent") {
      throw new ApiError(409, "送付済みの宛先のみ結果を記録できます", "INVALID_STATE");
    }

    const now = new Date();

    // 反響(電話)の確定値: 明示指定があればそれ、無ければ現状維持。
    const nextPhoneInquiryAt =
      input.phoneInquiry === undefined
        ? draft.phoneInquiryAt
        : input.phoneInquiry
          ? (draft.phoneInquiryAt ?? now)
          : null;

    // outcome は LP と電話の有無から再導出(永続キャッシュの同期)。
    const nextOutcome = deriveOutcome({
      lpFirstAccessAt: draft.lpFirstAccessAt,
      phoneInquiryAt: nextPhoneInquiryAt,
    });

    const nextDeliveryStatus = input.deliveryStatus ?? draft.deliveryStatus;
    const becameUndeliverable =
      input.deliveryStatus === "returned_undeliverable" &&
      draft.deliveryStatus !== "returned_undeliverable";

    const draftData: Record<string, unknown> = {
      phoneInquiryAt: nextPhoneInquiryAt,
      outcome: nextOutcome,
    };
    if (input.deliveryStatus !== undefined) {
      draftData.deliveryStatus = input.deliveryStatus;
      // 返送(宛先不明 / その他)を記録した時のみ returnedAt を立てる。それ以外は null へ戻す。
      draftData.returnedAt =
        input.deliveryStatus === "returned_undeliverable" ||
        input.deliveryStatus === "returned_other"
          ? now
          : null;
    }
    if (input.outcomeNote !== undefined) {
      draftData.outcomeNote = input.outcomeNote;
    }

    // 下書き更新と(宛先不明なら)物件連動を 1 トランザクションで行う。
    await prisma.$transaction(async (tx) => {
      await tx.dmRecipientDraft.update({ where: { id }, data: draftData });
      if (becameUndeliverable) {
        await tx.property.update({
          where: { id: draft.propertyId },
          data: { dmStatus: "no_send", dmUndeliverableAt: now },
        });
      }
    });

    // 非PII の監査(本文・宛名・住所・メモは残さない)。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_outcome_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: {
        propertyId: draft.propertyId,
        deliveryStatus: nextDeliveryStatus,
        outcome: nextOutcome,
        undeliverableLinked: becameUndeliverable,
        updatedAt: now.toISOString(),
      },
    });

    return NextResponse.json(
      { id, deliveryStatus: nextDeliveryStatus, outcome: nextOutcome, undeliverableLinked: becameUndeliverable },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
