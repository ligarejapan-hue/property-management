import { NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { requireScenarioAdmin, lockScenarioForUpdate, lpOptions } from "@/lib/sale-dm-letter/scenario-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";
import { splitLpTemplate, lpSplitIssueMessage, lpBodyHeadings } from "@/lib/sale-dm-letter/lp-template";
import { reconcileSectionMedia } from "@/lib/sale-dm-letter/lp-media";
import { rowsToPlan, planToRows } from "@/lib/sale-dm-letter/lp-media-rows";
import { saleDmLpTemplatePutSchema } from "@/lib/validators-sale-dm";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 台帳のLPの原本(外部AIの出力の貼り戻し保存。設計 §2.2/§2.3/§3.6)。台帳の手紙 template route
 * (scenarios/[id]/template)と同じ順序に、LP型の template route(lp-variants/[lpId]/template)
 * にある「小見出しへ付けた写真と図」の引き継ぎを足したもの。
 *
 * 台帳は複数の型から共有される原本なので、LP型の template route と違い凍結・担当範囲・
 * 下書きクリアという概念は無い(scenarios/[id]/template と同じ理由)。
 */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const parsed = saleDmLpTemplatePutSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id } });

      // 中身が同じ保存は何もしない(呼び出し側は取り直さずこの応答の指紋を持てる)。
      if (s.lpRawTemplate === parsed.body) {
        return { changed: false as const, sectionCount: 0 };
      }

      // 表示したときのLPの書き方の設定と、いまの設定が同じか。
      const prompt = buildLpExternalPrompt(lpOptions(s));
      if (promptDigest(prompt) !== parsed.promptDigest) {
        throw new ApiError(
          409,
          "LPの書き方の設定が変わっています。プロンプトを表示し直してから貼り付けてください",
          "PROMPT_STALE",
        );
      }
      // 画面を開いたときに見えていた原本と、いまの原本が同じか(2つのタブ問題対策。
      // scenarios/[id]/template と同じ理由)。
      if (bodyTemplateDigest(s.lpRawTemplate) !== parsed.baseBodyDigest) {
        throw new ApiError(
          409,
          "この種類のLPの文章は、ほかの画面で先に保存されています。開き直して最新の文章を確認してから貼り付けてください",
          "TEMPLATE_STALE",
        );
      }

      const split = splitLpTemplate(parsed.body);
      if (!split.ok) {
        throw new ApiError(400, lpSplitIssueMessage(split.issue), "INVALID_LP_TEMPLATE");
      }
      const { parts } = split;

      // 写真と図の枠を新しい小見出しに引き継ぐ(lp-variants/[lpId]/template と同じ考え方)。
      // 見出しの完全一致だけ残し、消えた見出しの行は落とす。ヒーロー行は本文と無関係なので触らない。
      const oldRows = await tx.dmScenarioMedia.findMany({
        where: { scenarioId: id, slot: "section" },
        orderBy: { sortOrder: "asc" },
        select: { slot: true, heading: true, assetId: true, figureKind: true, sortOrder: true },
      });
      const oldHeadings = [...new Set(lpBodyHeadings(s.lpBodyText ?? ""))];
      const newHeadings = [...new Set(lpBodyHeadings(parts.body))];
      const sections = reconcileSectionMedia(oldHeadings, newHeadings, rowsToPlan(oldRows).sections);

      await tx.dmScenario.update({
        where: { id },
        data: {
          lpRawTemplate: parsed.body,
          lpPromptText: prompt,
          lpHeadline: parts.headline,
          lpLead: parts.lead,
          lpBodyText: parts.body,
          lpFaqJson: parts.faq === null ? Prisma.DbNull : parts.faq,
        },
      });

      await tx.dmScenarioMedia.deleteMany({ where: { scenarioId: id, slot: "section" } });
      const sectionRows = planToRows({ hero: null, sections }).map((r) => ({ ...r, scenarioId: id }));
      if (sectionRows.length > 0) {
        await tx.dmScenarioMedia.createMany({ data: sectionRows });
      }

      return { changed: true as const, sectionCount: newHeadings.length };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_lp_template",
        targetTable: "dm_scenarios",
        targetId: id,
        // 非PII: 文字数と節数だけ(本文・見出しは残さない)。
        detail: { length: parsed.body.length, sectionCount: result.sectionCount },
      });
    }

    return NextResponse.json(
      { changed: result.changed, bodyDigest: bodyTemplateDigest(parsed.body) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
