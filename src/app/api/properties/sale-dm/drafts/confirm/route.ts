import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess } from "@/lib/sale-dm-letter/route-guard";
import { validateLetterBody } from "@/lib/sale-dm-letter/body-validation";
import { lockOwnersForShare } from "@/lib/dm-batch/locks";
import {
  resolveDraftRecipient,
  isRecipientStale,
  isGroupSplit,
} from "@/lib/sale-dm-letter/stale-recipient";

// id は UUID 厳格検証(非UUIDを Prisma に渡して 500 にしない=422)。上限で巨大配列も弾く。
const confirmSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

export async function POST(request: NextRequest) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { ids } = confirmSchema.parse(await parseJsonBody(request));
    // 作成者本人のキャンペーン配下の draft のみ確定(他人のキャンペーンの draft は対象外)。
    // 生成失敗(body="")は確定対象から除外(空letterの確定→印刷→送付を防ぐ)。
    // field_staff は作成 or 担当の物件の宛先のみ確定可(他 route と同じ record scope)。campaign 作成後に
    // 物件が別担当へ再割当された宛先は GET/print/export で隠れるため、stale id での一括確定も DB 側で除外。
    const where = {
      id: { in: ids },
      status: "draft" as const,
      body: { not: "" },
      campaign: { createdBy: session.id },
      ...(session.role === "field_staff"
        ? { property: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } }
        : {}),
    };

    const OWNER_ADDRESS_SELECT = {
      zip: true,
      address: true,
      currentZip: true,
      currentAddress: true,
    } as const;

    const count = await prisma.$transaction(async (tx) => {
      // ⚠確定の対象を、所有者をロックした**同じ処理の中で**読み直して判定する。
      //   ロックの外で判定すると、判定した直後に住所が変わっても確定が通ってしまう。
      const drafts = await tx.dmRecipientDraft.findMany({
        where,
        select: {
          id: true,
          body: true,
          variantId: true,
          propertyId: true,
          recipientZip: true,
          recipientAddress: true,
          representativeOwnerId: true,
          draftOwners: { select: { ownerId: true } },
        },
      });
      if (drafts.length === 0) return 0;

      // ⚠確定は**印刷の直前の唯一の関所**。個別編集の入口だけを塞いでも、AI生成の出力や
      //   この反映より前からあるデータに不正な本文があれば通ってしまう(@codex #375)。
      //   where の `body != ""` では空白のみ・差込記号の残り・長すぎる本文を止められない。
      //   1件でも不正なら確定全体を断る(黙って減らさない=既存の宛先変更の扱いと同じ)。
      const invalidCount = drafts.filter((d) => validateLetterBody(d.body) !== null).length;
      if (invalidCount > 0) {
        throw new ApiError(
          409,
          `本文に問題がある宛先が ${invalidCount} 件あります。空白だけ・差し込みの記号が残っている・長すぎる本文は確定できません`,
          "INVALID_BODY",
        );
      }

      const ownerIds = [
        ...new Set(
          drafts.flatMap((d) => [
            ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
            ...d.draftOwners.map((o) => o.ownerId),
          ]),
        ),
      ];
      // 既定のロック順（Owner → 物件 → 子行）に合わせて所有者を先に取る。
      await lockOwnersForShare(tx, ownerIds);

      // ロック順序（設計 §2.3）: Owner → variant → 物件親行 → 子行。
      // variant を掴むのは、PR-D2 の「貼り付け／適用」（凍結判定）と直列化するため。
      const variantIds = [...new Set(drafts.map((d) => d.variantId))].sort();
      if (variantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${variantIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }

      // field_staff は担当範囲を**ロックを保持したまま**見直す。where のリレーション述語は
      // ステートメントのスナップショットで評価されるため、判定〜commit の間の担当変更を
      // 防げない（アクセスを失った後の確定が通る）。admin/office は判定が常に真なので不要。
      if (session.role === "field_staff") {
        const propertyIds = [...new Set(drafts.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({
            where: {
              id: { in: propertyIds },
              OR: [{ createdBy: session.id }, { assignedTo: session.id }],
            },
            select: { id: true },
          });
          if (visible.length !== propertyIds.length) {
            throw new ApiError(
              409,
              "担当が変わった宛先が含まれています。画面を開き直してから確定してください",
              "SCOPE_CHANGED",
            );
          }
        }
      }

      const owners = await tx.owner.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, ...OWNER_ADDRESS_SELECT },
      });
      const ownerById = new Map(owners.map((o) => [o.id, o]));

      // ⚠控えた宛先と「いまの解決結果」が食い違う下書きは確定させない。
      //   そのまま刷ると、現住所を入れたのに引っ越し前の住所へ送ることになる。
      const stale = drafts.filter((d) => {
        const rep = d.representativeOwnerId
          ? (ownerById.get(d.representativeOwnerId) ?? null)
          : null;
        const group = d.draftOwners
          .map((o) => ownerById.get(o.ownerId))
          .filter((o): o is NonNullable<typeof o> => o != null);
        const owners = {
          representative: rep,
          group: group.length > 0 ? group : rep ? [rep] : [],
        };
        // ⚠代表の宛先が同じでも、**共有者の1人だけが引っ越した**なら作り直せば2通に割れる。
        //   代表の値しか見ないと、その1通がそのまま確定され、引っ越した人には
        //   別人の住所で届く。
        if (isGroupSplit(owners)) return true;
        return isRecipientStale(d, resolveDraftRecipient(owners));
      });
      if (stale.length > 0) {
        throw new ApiError(
          409,
          `送付先が変わった宛先が ${stale.length} 件あります。宛先を作り直してから確定してください`,
          "RECIPIENT_STALE",
        );
      }

      const result = await tx.dmRecipientDraft.updateMany({
        where: { ...where, id: { in: drafts.map((d) => d.id) } },
        data: { status: "confirmed", confirmedAt: new Date() },
      });
      return result.count;
    });

    await writeAuditLog({ userId: session.id, action: "sale_dm_drafts_confirm", targetTable: "dm_recipient_drafts", detail: { count, confirmedAt: new Date().toISOString() } });
    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleApiError(error); }
}
