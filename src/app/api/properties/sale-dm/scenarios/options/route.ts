import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireScenarioOptionsAccess, SCENARIO_OPTION_SELECT } from "@/lib/sale-dm-letter/scenario-guard";

/**
 * DMの種類の選択肢(id・name・sortOrder・autoKey だけ)。
 * 物件を編集できる人、または売却DMを使える人が取得できる(中身は返さない)。
 */
export async function GET() {
  try {
    await requireScenarioOptionsAccess();
    const scenarios = await prisma.dmScenario.findMany({
      where: { active: true, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: SCENARIO_OPTION_SELECT,
    });
    return NextResponse.json({ scenarios }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
