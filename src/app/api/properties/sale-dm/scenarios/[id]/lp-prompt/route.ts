import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api-helpers";
import { requireScenarioAdmin, lpOptions } from "@/lib/sale-dm-letter/scenario-guard";
import { buildLpExternalPrompt, promptDigest, bodyTemplateDigest } from "@/lib/sale-dm-letter/external-prompt";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 台帳のLPの指示文(外部AIへ貼る用)を組み立てて返す(設計 §2.2/§3.6)。手紙の prompt route
 * (scenarios/[id]/prompt)と同形。LP側の書き方の設定(語調・長さ・訴求・押しの強さ)の
 * どれかが未設定なら 400。中身の読み取りは管理者だけ。
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireScenarioAdmin();
    const { id } = await params;
    const s = await prisma.dmScenario.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw new ApiError(404, "DMの種類が見つかりません", "SCENARIO_NOT_FOUND");
    const opts = lpOptions(s);
    const prompt = buildLpExternalPrompt(opts);
    return NextResponse.json(
      {
        prompt,
        digest: promptDigest(prompt),
        bodyDigest: bodyTemplateDigest(s.lpRawTemplate),
        body: s.lpRawTemplate,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
