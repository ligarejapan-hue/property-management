import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireScenarioOptionsAccess, SCENARIO_OPTION_SELECT } from "@/lib/sale-dm-letter/scenario-guard";

/**
 * DMの種類の選択肢(id・name・sortOrder・autoKey・ready だけ)。
 * 物件を見られる人/編集できる人、または売却DMを使える人が取得できる(中身は返さない)。
 * `ready` = 手紙の本文(letterBodyTemplate)が空でないか(文面そのものは返さない・select して落とす)。
 *
 * `?includeInactive=1`: 「使わない」・削除済みも含めて返す(変更履歴で過去の値を名前で出すため)。
 * このときだけ active と deleted(boolean)を足す。削除日時そのものや中身は返さない。
 */
export async function GET(request: Request) {
  try {
    await requireScenarioOptionsAccess();
    if (new URL(request.url).searchParams.get("includeInactive") === "1") {
      const rows = await prisma.dmScenario.findMany({
        select: { ...SCENARIO_OPTION_SELECT, letterBodyTemplate: true, active: true, deletedAt: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      const scenarios = rows.map(({ deletedAt, letterBodyTemplate, ...r }) => ({
        ...r,
        ready: !!letterBodyTemplate?.trim(),
        deleted: deletedAt !== null,
      }));
      return NextResponse.json({ scenarios }, { headers: { "Cache-Control": "no-store" } });
    }
    const rows = await prisma.dmScenario.findMany({
      where: { active: true, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { ...SCENARIO_OPTION_SELECT, letterBodyTemplate: true },
    });
    const scenarios = rows.map(({ letterBodyTemplate, ...r }) => ({ ...r, ready: !!letterBodyTemplate?.trim() }));
    return NextResponse.json({ scenarios }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
