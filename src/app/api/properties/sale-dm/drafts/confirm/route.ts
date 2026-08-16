import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, parseJsonBody, ApiError } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess } from "@/lib/sale-dm-letter/route-guard";
import { validateLetterBody } from "@/lib/sale-dm-letter/body-validation";
import { markVariantsFrozen } from "@/lib/sale-dm-letter/freeze";
import { lockOwnersForShare } from "@/lib/dm-batch/locks";
import {
  findTerminalExclusions,
  isTerminalExcluded,
  type TerminalExclusionTx,
} from "@/lib/dm-batch/terminal-exclusion";
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
      // ①先読み（ロック無し）。ここでは対象の id と所有者だけを拾う。
      const pre = await tx.dmRecipientDraft.findMany({
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
      if (pre.length === 0) return 0;

      const ownerIds = [
        ...new Set(
          pre.flatMap((d) => [
            ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
            ...d.draftOwners.map((o) => o.ownerId),
          ]),
        ),
      ];
      // 既定のロック順（Owner → 物件 → 子行）に合わせて所有者を先に取る。
      await lockOwnersForShare(tx, ownerIds);

      // 拒否・宛先不明(terminal 反響)の宛先が混ざっていたら**確定全体を断る**(@codex #384 R1 P1)。
      // 作成時の除外だけだと、作成〜確定の間に記録された拒否が素通りする。A(宛名CSV)が
      // DL時に再検査して止めるのと同じく、確定=印刷手前の関所でも同じ述語を再評価する。
      // 部分確定にしない理由はこの route の既存方針と同じ(「1件でも不正なら確定全体を
      // 断る=黙って減らさない」)。Owner FOR SHARE 保持中=terminal writer と直列化。
      {
        const exclusionSets = await findTerminalExclusions(
          tx as unknown as TerminalExclusionTx,
          ownerIds,
          [...new Set(pre.map((d) => d.propertyId))],
        );
        const terminalCount = pre.filter((d) =>
          isTerminalExcluded(exclusionSets, {
            propertyId: d.propertyId,
            ownerIds: [
              ...(d.representativeOwnerId ? [d.representativeOwnerId] : []),
              ...d.draftOwners.map((o) => o.ownerId),
            ],
          }),
        ).length;
        if (terminalCount > 0) {
          throw new ApiError(
            409,
            `拒否・宛先不明が記録された宛先が ${terminalCount} 件含まれています(その方の別物件での記録も含みます)。宛先を作り直してから確定してください`,
            "TERMINAL_RECIPIENTS",
          );
        }
      }

      // ロック順序（設計 §2.3）: Owner → variant → 物件親行 → 子行。
      // variant を掴むのは、PR-D2 の「貼り付け／適用」（凍結判定）と直列化するため。
      const variantIds = [...new Set(pre.map((d) => d.variantId))].sort();
      if (variantIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ANY(${variantIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }

      // field_staff は担当範囲を**ロックを保持したまま**見直す。where のリレーション述語は
      // ステートメントのスナップショットで評価されるため、判定〜commit の間の担当変更を
      // 防げない（アクセスを失った後の確定が通る）。admin/office は判定が常に真なので不要。
      if (session.role === "field_staff") {
        const propertyIds = [...new Set(pre.map((d) => d.propertyId))].sort();
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

      // ②子行（draft）をロックしてから**読み直す**（順序 Owner → variant → 物件親行 → 子行）。
      // ⚠再生成は型のロックを取らないため、先読み〜確定の間に本文を差し替えられる。
      //   先読みの値だけで検査すると、検査を通っていない本文がそのまま確定される
      //   (@codex #375 R2)。ロック下で読み直した値で検査し、同じ tx で status を進める。
      const draftIds = pre.map((d) => d.id).sort();
      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE id = ANY(${draftIds}::uuid[]) ORDER BY id FOR UPDATE`;
      // ⚠読み直しでは `body != ""` を**外す**(@codex #375 R3)。型の設定変更や割当は
      //   本文を "" にするため、条件を残すとその宛先だけ黙って対象から消え、残りが
      //   確定される(空白なら全体を止めるのに、空だと素通り=扱いが不一致)。空になって
      //   いれば下の検査が "empty" として拾い、確定全体を断る。
      const { body: _bodyNotEmpty, ...whereForReread } = where;
      void _bodyNotEmpty;
      const drafts = await tx.dmRecipientDraft.findMany({
        where: { ...whereForReread, id: { in: draftIds } },
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

      // ⚠ロックした型は**先読み**から決めている。先読み〜ロックの間に割当（assign）が
      //   宛先を別の型へ移すと、読み直しに**ロックしていない型**が現れる。そのまま
      //   凍結印を立てると、子行を掴んだあとに親（型）を掴むことになり、型を先に掴む
      //   処理（貼り付け・設定変更・割当）と互い違いになって片方が異常終了する
      //   （@codex #376 R11）。ここでは**中止して取り直してもらう**
      //   （既存の「先読み〜ロックで集合が変わったら中止」と同じ扱い）。
      const lockedVariantIds = new Set(variantIds);
      if (drafts.some((d) => !lockedVariantIds.has(d.variantId))) {
        throw new ApiError(
          409,
          "宛先の型が変わりました。画面を開き直してから確定してください",
          "VARIANT_CHANGED",
        );
      }

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

      // ⚠確定を作る前に、その型へ凍結印を立てる（設計 §2.4）。確定の証拠は割当や
      //   個別編集で型から離れる／解除されるので、消える前に列へ固定する。
      await markVariantsFrozen(tx, drafts.map((d) => d.variantId));

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
