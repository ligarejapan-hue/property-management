import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError, parseJsonBody } from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import {
  requireScenarioAdmin,
  lockScenarioForUpdate,
  letterOptions,
} from "@/lib/sale-dm-letter/scenario-guard";
import {
  scenarioLetterPrompt,
  promptDigest,
  bodyTemplateDigest,
} from "@/lib/sale-dm-letter/external-prompt";
import {
  letterBodyIssueMessage,
  validateLetterBody,
} from "@/lib/sale-dm-letter/body-validation";

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({
  body: z.string(),
  // 表示したときの指示文の指紋(書き方の設定が変わっていないか)。
  promptDigest: z.string().length(64),
  // 画面を開いたときに見えていた原本の指紋(先に別の画面が保存していないか)。
  baseBodyDigest: z.string().length(64),
});

/**
 * 台帳の手紙の原本(外部AIの出力の貼り戻し保存。設計 §2.3/§3.6)。
 *
 * 順序: 台帳行を FOR UPDATE → 中身が同じなら何もしない → 書き方の指紋(Review Focus 4)・
 * 原本の指紋・本文を確認 → 保存。凍結・担当範囲・宛先の本文クリアは台帳(種類)には
 * 存在しない概念なので行わない(型・LP型と違い、台帳は複数の型から共有される原本)。
 */
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const { session } = await requireScenarioAdmin();
    const { id } = await params;
    const parsed = putSchema.parse(await parseJsonBody(request));

    const result = await prisma.$transaction(async (tx) => {
      await lockScenarioForUpdate(tx, id);
      const s = await tx.dmScenario.findUniqueOrThrow({ where: { id } });

      // 中身が同じ保存は何もしない(呼び出し側は取り直さずこの応答の指紋を持てる)。
      if (s.letterBodyTemplate === parsed.body) {
        return { changed: false as const };
      }

      // 表示したときの書き方の設定と、いまの設定が同じか。
      const prompt = scenarioLetterPrompt(letterOptions(s));
      if (promptDigest(prompt) !== parsed.promptDigest) {
        throw new ApiError(
          409,
          "書き方の設定が変わっています。プロンプトを表示し直してから貼り付けてください",
          "PROMPT_STALE",
        );
      }
      // 画面を開いたときに見えていた原本と、いまの原本が同じか。設定の指紋だけでは
      // 2つのタブが同じ値になるため、これを見ないと先に保存された文面を古い画面からの
      // 保存が黙って差し替えてしまう。
      if (bodyTemplateDigest(s.letterBodyTemplate) !== parsed.baseBodyDigest) {
        throw new ApiError(
          409,
          "この種類の文面は、ほかの画面で先に保存されています。開き直して最新の文面を確認してから貼り付けてください",
          "TEMPLATE_STALE",
        );
      }

      // 台帳の本文は複数の型にまたがるので差込タグを許可する。
      const issue = validateLetterBody(parsed.body, { allowTags: true });
      if (issue) {
        throw new ApiError(400, letterBodyIssueMessage(issue), "INVALID_BODY");
      }

      // 原本と、その本文を作ったときの指示文を同じ処理で保存する。
      await tx.dmScenario.update({
        where: { id },
        data: { letterBodyTemplate: parsed.body, letterPromptText: prompt },
      });
      return { changed: true as const };
    });

    if (result.changed) {
      await writeAuditLog({
        userId: session.id,
        action: "sale_dm_scenario_letter_template",
        targetTable: "dm_scenarios",
        targetId: id,
        // 非PII: 文字数だけ(本文・指示文は残さない)。
        detail: { length: parsed.body.length },
      });
    }

    return NextResponse.json(
      { ...result, bodyDigest: bodyTemplateDigest(parsed.body) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
