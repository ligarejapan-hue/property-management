import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireSaleDmAccess } from "@/lib/sale-dm-letter/route-guard";
import { loadSaleDmConfig } from "@/lib/sale-dm-letter/config-store";
import { resolveLpUrl, resolveTrackingBaseUrl } from "@/lib/sale-dm-letter/tracking";
import { missingSaleDmPrintRequirements } from "@/lib/sale-dm-letter/print-ready";
import { isLetterReady, isLpReady, LETTER_READY_SELECT, LP_READY_SELECT } from "@/lib/sale-dm-letter/scenario-copy";
import { SCENARIO_OPTION_SELECT } from "@/lib/sale-dm-letter/scenario-guard";
import { buildDmReadiness } from "@/lib/sale-dm-letter/dm-readiness";

// DMメニューの「準備チェック」(画面すっきり化 第4回 E・2026-10-16)。
// 門は売却DMの発送一覧と同じ requireSaleDmAccess(売却DMを使える人だけ)。
// ⚠返すのは「そろっているか」と足りない項目の名前・種類の名前だけ。設定の値(URL・差出人)や
//   手紙・LPの文面は返さない。判定は作成ボタン(saleDmPrintReady)・作成時の検査と同じ関数を使う。
export async function GET() {
  try {
    await requireSaleDmAccess();
    const cfg = await loadSaleDmConfig();
    const settingsMissing = missingSaleDmPrintRequirements({
      trackingBaseUrl: resolveTrackingBaseUrl(cfg),
      lpUrl: resolveLpUrl(cfg),
      senderName: cfg.senderName,
      senderContact: cfg.senderContact,
    });
    const rows = await prisma.dmScenario.findMany({
      where: { active: true, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { ...SCENARIO_OPTION_SELECT, ...LETTER_READY_SELECT, ...LP_READY_SELECT },
    });
    const scenarios = rows.map((r) => ({
      id: r.id,
      name: r.name,
      letterReady: isLetterReady(r),
      lpReady: isLpReady(r),
    }));
    return NextResponse.json(buildDmReadiness({ settingsMissing, scenarios }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
