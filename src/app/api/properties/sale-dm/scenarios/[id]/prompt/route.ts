import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireScenarioAdmin, letterOptions } from "@/lib/sale-dm-letter/scenario-guard";
import {
  scenarioLetterPrompt,
  promptDigest,
  bodyTemplateDigest,
} from "@/lib/sale-dm-letter/external-prompt";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 台帳の手紙の指示文(外部AIへ貼る用)を組み立てて返す(設計 §2.2/§3.6)。
 * 書き方の設定(語調・長さ・訴求・押しの強さ・デザイン)のどれかが未設定なら 400。
 * 中身の読み取りは管理者だけ。
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const s = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    const opts = letterOptions(s);
    const prompt = scenarioLetterPrompt(opts);
    return NextResponse.json(
      {
        prompt,
        digest: promptDigest(prompt),
        bodyDigest: bodyTemplateDigest(s.letterBodyTemplate),
        body: s.letterBodyTemplate,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
