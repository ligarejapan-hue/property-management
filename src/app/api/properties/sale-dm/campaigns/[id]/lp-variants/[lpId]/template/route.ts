import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireSaleDmWriteAccess, assertSaleDmCampaignOwned } from "@/lib/sale-dm-letter/route-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";
import { SETTLED_DRAFT_STATUSES, isVariantFrozen } from "@/lib/sale-dm-letter/freeze";
import { splitLpTemplate, lpSplitIssueMessage } from "@/lib/sale-dm-letter/lp-template";
import { saleDmLpTemplatePutSchema } from "@/lib/validators-sale-dm";

/**
 * LP型の貼り戻し保存(設計 2026-09-08 §2.2)。DM型の template route と同じ順序:
 * dm_lp_variants を FOR UPDATE → 同一原文なら何も書かない → 凍結(初期化は許可)→ 指紋2つ → 切り分け →
 * 担当範囲(field_staff は物件親行をロックして読み直す)→ 原文+4部位+プロンプト控えを同じ tx で保存。
 * LP は表示のたびに展開するので、DM型と違い下書きのクリアは無い。
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; lpId: string }> }) {
  try {
    const { session } = await requireSaleDmWriteAccess();
    const { id, lpId } = await params;
    await assertSaleDmCampaignOwned(id, session.id);
    const parsed = saleDmLpTemplatePutSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dm_lp_variants WHERE id = ${lpId}::uuid AND campaign_id = ${id}::uuid FOR UPDATE`;
      const v = await tx.dmLpVariant.findFirst({
        where: { id: lpId, campaignId: id },
        select: { id: true, tone: true, length: true, appeal: true, strength: true, templateFrozenAt: true, rawTemplate: true },
      });
      if (!v) throw new ApiError(404, "指定されたLP型が見つかりません", "LP_VARIANT_NOT_FOUND");
      if (v.rawTemplate === parsed.body) {
        return { changed: false as const, bodyDigest: bodyTemplateDigest(parsed.body) };
      }
      const settledCount = await tx.dmRecipientDraft.count({
        where: { campaignId: id, lpVariantId: lpId, status: { in: [...SETTLED_DRAFT_STATUSES] } },
      });
      const frozen = isVariantFrozen({ templateFrozenAt: v.templateFrozenAt, settledCount });
      const isInitialization = !v.rawTemplate || v.rawTemplate.trim().length === 0;
      if (frozen && !isInitialization) {
        throw new ApiError(409, "送付実績のあるLP型の文章は変更できません。文章を変えるときは新しいLP型を追加してください", "VARIANT_FROZEN");
      }
      const prompt = buildLpExternalPrompt(v);
      if (promptDigest(prompt) !== parsed.promptDigest) {
        throw new ApiError(409, "LP型の設定が変わっています。プロンプトを表示し直してから貼り付けてください", "PROMPT_STALE");
      }
      if (bodyTemplateDigest(v.rawTemplate) !== parsed.baseBodyDigest) {
        throw new ApiError(409, "このLP型の文章は、ほかの画面で先に保存されています。開き直して最新の文章を確認してから貼り付けてください", "TEMPLATE_STALE");
      }
      const split = splitLpTemplate(parsed.body);
      if (!split.ok) throw new ApiError(400, lpSplitIssueMessage(split.issue), "INVALID_LP_TEMPLATE");

      if (session.role === "field_staff") {
        // ⚠**送付済みの宛先も担当範囲の対象に含める**(@codex R1 P1)。DM本文は送付の時点で
        //   下書きに焼き付くが、**LPは送付済みの宛先にも表示される**(QRを読むたびに、この型の
        //   文章をその場で展開する)。status で絞ると、担当外へ再割当された送付済み宛先しか
        //   残っていない凍結LP型(原文が空＝初期化は許可)で対象が0件になり、元担当が
        //   「自分には見えない宛先へ表示される文章」を入れられてしまう。
        const targets = await tx.dmRecipientDraft.findMany({
          where: { campaignId: id, lpVariantId: lpId },
          select: { propertyId: true },
        });
        const propertyIds = [...new Set(targets.map((d) => d.propertyId))].sort();
        if (propertyIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM properties WHERE id = ANY(${propertyIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const visible = await tx.property.findMany({
            where: { id: { in: propertyIds }, OR: [{ createdBy: session.id }, { assignedTo: session.id }] },
            select: { id: true },
          });
          if (visible.length !== propertyIds.length) {
            throw new ApiError(403, "担当外の宛先を含むLP型は文章を保存できません", "FORBIDDEN");
          }
        }
      }

      const { parts } = split;
      await tx.dmLpVariant.update({
        where: { id: lpId },
        data: {
          rawTemplate: parsed.body,
          promptText: prompt,
          headline: parts.headline,
          lead: parts.lead,
          bodyText: parts.body,
          faqJson: parts.faq === null ? Prisma.DbNull : parts.faq,
        },
      });
      return {
        changed: true as const,
        bodyDigest: bodyTemplateDigest(parsed.body),
        parts: { headline: parts.headline, lead: parts.lead, faqCount: parts.faq?.length ?? 0, bodyLength: parts.body.length },
      };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_lp_body_paste",
        targetTable: "dm_lp_variants",
        targetId: lpId,
        // 非PII: 件数・長さ・日時のみ(見出し・本文は残さない)。
        detail: { campaignId: id, faqCount: result.parts.faqCount, bodyLength: result.parts.bodyLength, pastedAt: new Date().toISOString() },
      });
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
