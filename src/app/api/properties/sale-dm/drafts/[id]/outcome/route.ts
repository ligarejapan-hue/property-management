import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { deriveOutcome } from "@/lib/sale-dm-letter/outcome";
import { lockPropertyRow } from "@/lib/property-record-guard";
import { lockOwnersForUpdate, type RawTx } from "@/lib/dm-batch/locks";
import { syncSaleDmReaction, type ReactionSyncTx } from "@/lib/dm-reaction/sync";
import { jstCalendarDay } from "@/lib/dm-reaction/core";

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
        sentAt: true,
        campaign: { select: { createdBy: true } },
        property: { select: { createdBy: true, assignedTo: true } },
      },
    });
    // 作成者本人のキャンペーン配下の下書きのみ操作可(他人UUIDでの横断アクセス防止)。
    // 存在を漏らさないため not-found / not-owned は同じ 404。
    if (!draft || draft.campaign.createdBy !== session.id) {
      throw new ApiError(404, "下書きが見つかりません", "NOT_FOUND");
    }
    // field_staff は作成 or 担当の物件の宛先のみ操作可(物件APIと同じ record scope)。状態(409)より先に
    // 認可(403)を判定し、担当外(再割当で隠れた)下書きの送付状態を 409 vs 403 で漏らさない
    // (他の draft route=PATCH/regenerate/mark-sent と順序を統一)。
    if (
      session.role === "field_staff" &&
      draft.property.createdBy !== session.id &&
      draft.property.assignedTo !== session.id
    ) {
      throw new ApiError(403, "この宛先を操作する権限がありません", "FORBIDDEN");
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

    // 配達状態の遷移(宛先不明への変化/宛先不明からの訂正)は、並行 PATCH で stale にならないよう、tx 内で
    // ロック下の最新 deliveryStatus から判定する(下記)。ここでは先に権限を確認する。

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

    // 下書き更新と物件連動を 1 トランザクションで行う。並行(同一下書きへの公開/t/ヒット、同一物件への別宛先の
    // 同時 outcome 更新)に備え、関係行を FOR UPDATE でロックしてから最新値で判定する(R34 残レース対応)。
    const txResult = await prisma.$transaction(async (tx) => {
      // R47(PR-B): terminal(returned_undeliverable)を書き込むリクエスト、または draft が既に
      // 返送済み(deliveryStatus を変えないメモ・電話編集でも同期が terminal を書き得る=@codex #366 R2 P2)
      // のときは、対象所有者集合(代表+連関全員)を親行より先に FOR UPDATE する
      // (mark-sent と同じ「先読み→Owner→親→子」の型)。同期対象の旧sale_dm行(同一物件+同日)も
      // 集合に含める(通常は連関なし=空)。
      if (
        input.deliveryStatus === "returned_undeliverable" ||
        draft.deliveryStatus === "returned_undeliverable"
      ) {
        const syncTargets = await tx.propertyDmLog.findMany({
          where: {
            OR: [
              { draftId: id },
              ...(draft.sentAt
                ? [
                    {
                      method: "sale_dm",
                      draftId: null,
                      propertyId: draft.propertyId,
                      sentAt: new Date(
                        `${jstCalendarDay(draft.sentAt)}T00:00:00Z`,
                      ),
                    },
                  ]
                : []),
            ],
          },
          select: { ownerId: true, logOwners: { select: { ownerId: true } } },
        });
        const ownerIds = syncTargets.flatMap((l) => [
          ...(l.ownerId ? [l.ownerId] : []),
          ...l.logOwners.map((o) => o.ownerId),
        ]);
        await lockOwnersForUpdate(tx as unknown as RawTx, ownerIds);
      }
      // ロック順序は親(物件)→子(draft)に統一(PR-B: 従来は解除分岐のみ物件ロック=子→親の順だった)。
      await lockPropertyRow(tx, draft.propertyId);
      // C3(レース): 下書き行をロックして lpFirstAccessAt/phoneInquiryAt を最新で読み直し outcome を再導出する。
      // 公開 /t/ の同時ヒットが lpFirstAccessAt+outcome=inquiry を書いた直後に、進入時の古い snapshot 由来の
      // outcome(none)で上書きして自己矛盾(lpあり/outcome=none)になるのを防ぐ(/t/ の UPDATE と直列化)。
      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.dmRecipientDraft.findUnique({ where: { id }, select: { lpFirstAccessAt: true, phoneInquiryAt: true, deliveryStatus: true } });
      const freshPhoneInquiryAt =
        input.phoneInquiry === undefined
          ? (fresh?.phoneInquiryAt ?? null)
          : input.phoneInquiry
            ? (fresh?.phoneInquiryAt ?? now)
            : null;
      const freshOutcome = deriveOutcome({ lpFirstAccessAt: fresh?.lpFirstAccessAt ?? null, phoneInquiryAt: freshPhoneInquiryAt });

      // 配達状態の遷移もロック下の最新 deliveryStatus から判定する。進入時 snapshot だと、別 PATCH が
      // returned_undeliverable を解除/再設定した結果を見落とし、物件の dmUndeliverableAt/dmStatus 連動を誤る
      // (例: 並行で delivered に解除された後にこの request が再設定→ becameUndeliverable を取りこぼし no_send 復帰を skip)。
      const currentDeliveryStatus = fresh?.deliveryStatus ?? draft.deliveryStatus;
      const nextDeliveryStatus = input.deliveryStatus ?? currentDeliveryStatus;
      const becameUndeliverable =
        input.deliveryStatus === "returned_undeliverable" && currentDeliveryStatus !== "returned_undeliverable";
      // 宛先不明から他状態へ訂正したら自動連動の物件フラグ(dmUndeliverableAt)を解除(dmStatus は人の判断で戻す)。
      const clearedUndeliverable =
        input.deliveryStatus !== undefined &&
        input.deliveryStatus !== "returned_undeliverable" &&
        currentDeliveryStatus === "returned_undeliverable";

      await tx.dmRecipientDraft.update({ where: { id }, data: { ...draftData, phoneInquiryAt: freshPhoneInquiryAt, outcome: freshOutcome } });

      // ブリッジ行(送付記録)へ反響を同期(PR-B): 返戻→宛先不明 / LP・電話→連絡あり / 訂正→復元。
      // 物件フラグの再計算より先に行い、下の残数カウントが同期後の最終状態を数えるようにする。
      await syncSaleDmReaction(tx as unknown as ReactionSyncTx, id);

      let cleared = false;
      if (becameUndeliverable) {
        await tx.property.update({
          where: { id: draft.propertyId },
          data: { dmStatus: "no_send", dmUndeliverableAt: now },
        });
      } else if (clearedUndeliverable) {
        // C2(レース): 物件行ロック(tx 冒頭で取得済み)下で兄弟を数える。同一物件への同時 outcome 更新を
        // 直列化し、互いの未コミット変更を見落として「宛先不明」フラグを取り残す/誤って消すのを防ぐ。
        // 同一物件に「宛先不明」のまま残る他の送付済み宛先(別の所有者住所グループや別キャンペーン)や、
        // 汎用送付記録側の宛先不明反響(手動記録=PR-B)がなければ物件フラグを解除する。
        const [stillUndeliverable, undeliverableLogs] = await Promise.all([
          tx.dmRecipientDraft.count({
            where: {
              propertyId: draft.propertyId,
              status: "sent",
              deliveryStatus: "returned_undeliverable",
              id: { not: id },
            },
          }),
          tx.propertyDmLog.count({
            where: { propertyId: draft.propertyId, reactionStatus: "undeliverable" },
          }),
        ]);
        if (stillUndeliverable + undeliverableLogs === 0) {
          await tx.property.update({
            where: { id: draft.propertyId },
            data: { dmUndeliverableAt: null },
          });
          cleared = true;
        }
      }
      return { cleared, outcome: freshOutcome, becameUndeliverable, nextDeliveryStatus };
    });
    const undeliverableCleared = txResult.cleared;
    const finalOutcome = txResult.outcome;
    const finalBecameUndeliverable = txResult.becameUndeliverable;
    const finalDeliveryStatus = txResult.nextDeliveryStatus;

    // 非PII の監査(本文・宛名・住所・メモは残さない)。
    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_draft_outcome_update",
      targetTable: "dm_recipient_drafts",
      targetId: id,
      detail: {
        propertyId: draft.propertyId,
        deliveryStatus: finalDeliveryStatus,
        outcome: finalOutcome,
        undeliverableLinked: finalBecameUndeliverable,
        undeliverableCleared,
        updatedAt: now.toISOString(),
      },
    });

    return NextResponse.json(
      { id, deliveryStatus: finalDeliveryStatus, outcome: finalOutcome, undeliverableLinked: finalBecameUndeliverable, undeliverableCleared },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
