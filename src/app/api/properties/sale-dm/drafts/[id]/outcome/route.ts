import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
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
    const { session, permissions } = await requireSaleDmAccess();
    const { id } = await params;
    // 不正JSON は parseJsonBody で 400(request.json() の素の 500 を避ける。他 mutation route と統一)。
    const input = outcomeSchema.parse(await parseJsonBody(request));

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
        property: { select: { createdBy: true, assignedTo: true } },
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
    // 宛先不明から他状態へ訂正したら、自動連動で立てた物件の宛先不明フラグ
    // (dmUndeliverableAt)を解除する(物件一覧バッジ/フィルタは dmUndeliverableAt 基準)。
    // dmStatus は人の判断で戻す(手動 clear-undeliverable と同方針)ため自動では触らない。
    const clearedUndeliverable =
      input.deliveryStatus !== undefined &&
      input.deliveryStatus !== "returned_undeliverable" &&
      draft.deliveryStatus === "returned_undeliverable";

    // field_staff は作成 or 担当の物件の宛先のみ結果を記録できる(物件APIと同じ record scope)。
    // 配達結果/反響/メモのいずれの outcome 更新も対象。campaign 作成後に物件が別担当へ再割当されると
    // GET/print/export では隠れるため、隠れた宛先の結果も書き換えさせない(物件mutationの有無に依らず常時適用)。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この宛先を操作する権限がありません", "FORBIDDEN");
    }

    // outcome 更新は配達/反響/メモいずれも下書きの delivery/response 記録を書き換え、A/B 集計に反映される。
    // 権限失効後に送付済みの結果を改竄(集計汚染)させないため、全 outcome 更新に property:write を要求する
    // (従来は宛先不明の設定/解除=properties 書込時のみ。mark-sent と同じ write ゲートに統一)。
    if (!hasPermission(permissions, "property", "write")) {
      throw new ApiError(403, "配達結果・反響を更新する権限(write)がありません", "FORBIDDEN");
    }

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

    // 下書き更新と物件連動を 1 トランザクションで行う。宛先不明の解除は、同じ物件に
    // 他の未解決(returned_undeliverable)送付済み宛先が残らない場合のみ実施する。
    const undeliverableCleared = await prisma.$transaction(async (tx) => {
      await tx.dmRecipientDraft.update({ where: { id }, data: draftData });
      if (becameUndeliverable) {
        await tx.property.update({
          where: { id: draft.propertyId },
          data: { dmStatus: "no_send", dmUndeliverableAt: now },
        });
        return false;
      }
      if (clearedUndeliverable) {
        // 同一物件に「宛先不明」のまま残る他の送付済み宛先(別の所有者住所グループや
        // 別キャンペーン)がなければ物件フラグを解除。残っていれば物件はまだ宛先不明なので
        // 一覧バッジ/フィルタ(dmUndeliverableAt 基準)を誤って消さない。
        const stillUndeliverable = await tx.dmRecipientDraft.count({
          where: {
            propertyId: draft.propertyId,
            status: "sent",
            deliveryStatus: "returned_undeliverable",
            id: { not: id },
          },
        });
        if (stillUndeliverable === 0) {
          await tx.property.update({
            where: { id: draft.propertyId },
            data: { dmUndeliverableAt: null },
          });
          return true;
        }
      }
      return false;
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
        undeliverableCleared,
        updatedAt: now.toISOString(),
      },
    });

    return NextResponse.json(
      { id, deliveryStatus: nextDeliveryStatus, outcome: nextOutcome, undeliverableLinked: becameUndeliverable, undeliverableCleared },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
