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
 * ロック順序: dm_lp_variants → properties → dm_recipient_drafts(dm_variants は触らない)。
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

      // ⚠field_staff の担当範囲を、**設定を変える前に**確かめる(@codex R2 P1・DM型の
      //   variants/[variantId] PATCH と同じ形)。この型の文章は担当外(再割当で隠れた)の
      //   宛先のLPにも表示されるので、設定変更で原文・切り分け結果を消すと、自分に見えない
      //   宛先の表示まで白紙にしてしまう。1件でも担当外が居れば拒否する(label だけ＝何も
      //   消えない場合はここを通さない)。
      // ⚠判定は**物件親行をロックしてから**数える(数えた直後〜commit の間に担当が
      //   変わるのを防ぐ)。ロック順序は dm_lp_variants(:28 で取得済み)→ properties → draft 行。
      //   物件親行は**必ず draft 行のロックより先**に取る(取得順を全経路でそろえる)。
      if (optionFieldChanged && session.role === "field_staff") {
        // 送付済みは下の sentBefore>0 で 409 になるが、担当範囲の判定は未送付だけを見る
        // (消えるのは未送付の表示だけ・送付済みは status で除外)。
        const targets = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, lpVariantId: lpId, status: { not: "sent" } },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(targets.map((t) => t.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const outOfScope = await tx.dmRecipientDraft.count({
            where: {
              campaignId: id,
              lpVariantId: lpId,
              status: { not: "sent" },
              // 「担当外」= 可視条件(createdBy==me OR assignedTo==me)の否定。assignedTo が NULL の
              // 未割当物件も担当外として数えるため、`{not}` の AND ではなく NOT(OR) を使う。
              property: { NOT: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } },
            },
          });
          if (outOfScope > 0) {
            throw new ApiError(403, "担当外の宛先を含むLP型は設定を変更できません", "FORBIDDEN");
          }
        }
      }

      // ⚠**このLP型の宛先行をロックしてから送付済みを数える**(@codex R2 P2・DM型の PATCH と同じ形)。
      //   ラベルだけの変更は下書き行に触れないので、ロックが無いと mark-sent と直列化されない
      //   ＝「送付済み0件」と数えた直後に送付が確定し、そのあとで書いたラベルの下に
      //   **すでに送り終えた実績**がぶら下がる(集計はラベルをその都度引くため)。
      //   ロック順序(設計 §2.3/§2.8): dm_lp_variants → properties → dm_recipient_drafts。
      await tx.$queryRaw`SELECT id FROM dm_recipient_drafts WHERE campaign_id = ${id}::uuid AND lp_variant_id = ${lpId}::uuid FOR UPDATE`;

      // 送付済みの宛先が使っているLP型は label を含め一切変更不可(DM型と同じ・ラベルは
      // A/B集計・送付履歴に載るため、文体を変えなくても送付後の書き換えは整合を崩す)。
      const sentBefore = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: "sent" },
      });
      if (sentBefore > 0) {
        throw new ApiError(
          409,
          "送付済みの宛先があるLP型は設定を変更できません(A/B履歴の整合のため)",
          "VARIANT_LOCKED",
        );
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
      const updated = await tx.dmLpVariant.update({ where: { id: lpId, campaignId: id }, data });
      // 更新中に別 request がこのLP型の宛先を sent 化していたら、送った構成を書き換えたことに
      // なる → ロールバック(DM型の sentAfter と同じ二重の備え)。
      const sentAfter = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: "sent" },
      });
      if (sentAfter > 0) {
        throw new ApiError(
          409,
          "送付済みの宛先があるLP型は設定を変更できません(A/B履歴の整合のため)",
          "VARIANT_LOCKED",
        );
      }
      return updated;
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

    const { deleted, detachedCount } = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const row = await tx.dmLpVariant.findFirst({ where: { id: lpId, campaignId: id }, select: { templateFrozenAt: true } });
      if (!row) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      if (isVariantFrozen({ templateFrozenAt: row.templateFrozenAt, settledCount })) {
        throw new ApiError(409, "送付実績のあるLP型は削除できません", "VARIANT_FROZEN");
      }
      // ⚠field_staff の担当範囲を、**下の detach で割当を外す前に**確かめる(@codex R6 P1・
      //   PATCH の同種チェックと同じ形)。この型を可視の(自分が担当する)宛先から削除しても、
      //   同じ型を参照している担当外(再割当で隠れた)宛先の割当を巻き込みで外してしまうため
      //   (1件でも担当外が居れば削除自体を拒否する)。
      // ⚠判定は**物件親行をロックしてから**数える(数えた直後〜commit の間に担当が
      //   変わるのを防ぐ)。ロック順序は dm_lp_variants(上でロック済み)→ properties → draft 行。
      if (session.role === "field_staff") {
        const targets = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, lpVariantId: lpId, status: { not: "sent" } },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(targets.map((t) => t.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const outOfScope = await tx.dmRecipientDraft.count({
            where: {
              campaignId: id,
              lpVariantId: lpId,
              status: { not: "sent" },
              // 「担当外」= 可視条件(createdBy==me OR assignedTo==me)の否定。assignedTo が NULL の
              // 未割当物件も担当外として数えるため、`{not}` の AND ではなく NOT(OR) を使う。
              property: { NOT: { OR: [{ createdBy: session.id }, { assignedTo: session.id }] } },
            },
          });
          if (outOfScope > 0) {
            throw new ApiError(403, "担当外の宛先を含むLP型は削除できません", "FORBIDDEN");
          }
        }
      }
      // ⚠削除前に未送付の宛先を割当なしへ戻す(@codex R5 finding)。ここまで来ていれば
      //   確定/送付済みの宛先は無い(上の isVariantFrozen が settledCount>0 で既に拒否済み)ので、
      //   この型を参照している下書きは status="draft" のみ(status: not sent は将来の競合への保険)。
      //   このLP型を持ったまま宛先が残っていると、下の deleteMany の recipients:{none:{}} 条件に
      //   引っかかって削除できない(＝唯一のLP型が消せなくなる原因)。
      const detach = await tx.dmRecipientDraft.updateMany({
        where: { campaignId: id, lpVariantId: lpId, status: { not: "sent" } },
        data: { lpVariantId: null },
      });
      // 宛先を1件も持たない場合のみ削除(count→delete の隙間を作らない)。上の detach 後は
      // 通常0件のはずだが、万一残っていれば(競合で送付済みが紛れ込んだ等)ここで 409 に倒す。
      const result = await tx.dmLpVariant.deleteMany({ where: { id: lpId, campaignId: id, recipients: { none: {} } } });
      return { deleted: result, detachedCount: detach.count };
    });
    if (deleted.count === 0) throw new ApiError(409, "このLP型は宛先に割り当てられているため削除できません", "VARIANT_IN_USE");

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_lp_variant_delete",
      targetTable: "dm_lp_variants",
      targetId: lpId,
      detail: { campaignId: id, detachedCount, deletedAt: new Date().toISOString() },
    });
    return NextResponse.json({ deleted: lpId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
