import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  requireSaleDmWriteAccess,
  assertSaleDmCampaignOwned,
} from "@/lib/sale-dm-letter/route-guard";
import {
  coarsePropertyLocation,
  expandLetterTags,
  hasUnresolvedTag,
  propertyTypeLabel,
} from "@/lib/sale-dm-letter/tags";
import { validateLetterBody } from "@/lib/sale-dm-letter/body-validation";

const postSchema = z.object({
  // 既定は「本文が空の宛先だけ」。個別の手直しを黙って消さないため（設計 §2.3）。
  overwriteExisting: z.boolean().optional(),
});

/**
 * 型の本文を、その型の全宛先へ差し込んで適用する（設計 §2.3）。
 *
 * ロック順序: variant → 物件親行（field_staff のみ）→ 子行(draft)。
 * 担当外・タグ未解決は**黙って落とさず件数で報告**する。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; variantId: string }> },
) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, variantId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = postSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_variants WHERE id = ${variantId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;

      const variant = await tx.dmVariant.findFirst({
        where: { id: variantId, campaignId: id },
        select: { id: true, bodyTemplate: true },
      });
      if (!variant) {
        throw new ApiError(
          404,
          "指定された型が見つかりません",
          "VARIANT_NOT_FOUND",
        );
      }
      // ⚠凍結済みでも**同じ本文の適用は許可**する。割当で別の型へ移された下書きは
      //   本文が空になるため、再適用を禁止すると空のまま進めない詰みになる
      //   （禁止すべきは差し替えであって適用ではない＝設計 §2.3 @codex R15）。
      if (!variant.bodyTemplate || variant.bodyTemplate.trim().length === 0) {
        throw new ApiError(
          409,
          "この型にはまだ本文が保存されていません。先に本文を貼り付けてください",
          "TEMPLATE_MISSING",
        );
      }

      // 対象は「まだ確定していない」下書きだけ。確定済み・送付済みは触らない。
      const targets = await tx.dmRecipientDraft.findMany({
        where: {
          campaignId: id,
          variantId,
          status: "draft",
          ...(parsed.overwriteExisting ? {} : { body: "" }),
        },
        select: {
          id: true,
          body: true,
          status: true,
          propertyId: true,
          property: {
            select: {
              id: true,
              address: true,
              propertyType: true,
              createdBy: true,
              assignedTo: true,
            },
          },
        },
      });
      if (targets.length === 0) {
        return { appliedCount: 0, skippedScopeCount: 0, skippedTagCount: 0 };
      }

      // field_staff は担当外の宛先を**原子的に除外**する。CSV/印刷が既に隠している
      // 宛先を一括適用だけが書き換えられるのは認可の穴（設計 §2.3 @codex R4）。
      // 1件の担当変更でキャンペーン全体を止めないよう、拒否ではなく除外＋件数報告。
      let inScope = targets;
      let skippedScopeCount = 0;
      if (session.role === "field_staff") {
        const propertyIds = [...new Set(targets.map((t) => t.propertyId))].sort();
        // ⚠where のリレーション述語だけでは判定〜commit の間の担当変更を防げないため、
        //   物件親行をロックしてから担当範囲を確定させる（設計 §2.3 @codex R6）。
        await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
        // ⚠**ロックを取ってから読み直す**(@codex #376 P1)。先読みの値で判定すると、
        //   ロック待ちの間に確定した担当変更を見落とし、担当外になった宛先を書き換える。
        const fresh = await tx.property.findMany({
          where: { id: { in: propertyIds } },
          select: { id: true, createdBy: true, assignedTo: true },
        });
        const visible = new Set(
          fresh
            .filter(
              (p) => p.createdBy === session.id || p.assignedTo === session.id,
            )
            .map((p) => p.id),
        );
        inScope = targets.filter((t) => visible.has(t.propertyId));
        skippedScopeCount = targets.length - inScope.length;
      }

      // 同じ本文になる宛先はまとめて1回で書く（タグを使わない文面なら全件が1回）。
      const byBody = new Map<string, string[]>();
      let skippedTagCount = 0;
      for (const t of inScope) {
        const expanded = expandLetterTags(variant.bodyTemplate, {
          location: coarsePropertyLocation(t.property.address),
          propertyType: propertyTypeLabel(t.property.propertyType),
        });
        // 差し込めなかった宛先（所在が空など）は飛ばす。プレースホルダのまま
        // 郵送されるのを防ぐ保険（設計 §2.3）。展開後は厳密版で検査する。
        if (hasUnresolvedTag(expanded) || validateLetterBody(expanded) !== null) {
          skippedTagCount += 1;
          continue;
        }
        const bucket = byBody.get(expanded);
        if (bucket) bucket.push(t.id);
        else byBody.set(expanded, [t.id]);
      }

      let appliedCount = 0;
      for (const [body, ids] of byBody) {
        const r = await tx.dmRecipientDraft.updateMany({
          // 状態はもう一度 where で縛る（読み取り〜書き込みの間に確定/送付された分を書かない）。
          where: {
            id: { in: ids },
            campaignId: id,
            variantId,
            status: "draft",
            // ⚠上書きしない指定のときは、書き込み条件にも「本文が空」を残す(@codex #376 P2)。
            //   読み取り〜書き込みの間に手直しされた本文を、黙って置き換えないため。
            ...(parsed.overwriteExisting ? {} : { body: "" }),
          },
          data: { body },
        });
        appliedCount += r.count;
      }

      return { appliedCount, skippedScopeCount, skippedTagCount };
    });

    await writeAuditLog({
      userId: session.id,
      action: "sale_dm_template_apply",
      targetTable: "dm_recipient_drafts",
      targetId: variantId,
      // 非PII: 件数・ID・日時のみ（本文は残さない）。多数の本文を書き換える操作なので
      // 除外・スキップの件数も残す（設計 §2.6）。
      detail: {
        campaignId: id,
        appliedCount: result.appliedCount,
        skippedScopeCount: result.skippedScopeCount,
        skippedTagCount: result.skippedTagCount,
        appliedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
