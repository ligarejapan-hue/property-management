import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleApiError } from "@/lib/api-helpers";
import { requireScenarioOptionsAccess, SCENARIO_OPTION_SELECT } from "@/lib/sale-dm-letter/scenario-guard";
import { isLetterReady, LETTER_READY_SELECT, type LetterReadyFields } from "@/lib/sale-dm-letter/scenario-copy";

/**
 * 判定用の列(本文・書き方)を落とし、`ready` だけを足す(文面そのものは返さない)。
 * `ready` は作成・種類を変えるの準備の検査(checkScenarioReady)と同じ isLetterReady で決める
 * (選べるのに作成で止まる、という食い違いを作らない)。
 */
function withReady<T extends LetterReadyFields>(row: T) {
  const { letterBodyTemplate, designTemplate, tone, length, appeal, strength, ...rest } = row;
  const ready = isLetterReady({ letterBodyTemplate, designTemplate, tone, length, appeal, strength });
  return { ...rest, ready };
}

/**
 * DMの種類の選択肢(id・name・sortOrder・autoKey・ready だけ)。
 * 物件を見られる人/編集できる人、または売却DMを使える人が取得できる(中身は返さない)。
 * `ready` = 手紙として写せるか(本文が空でない+書き方5項目が設定済み・判定用の列は select して落とす)。
 *
 * `?includeInactive=1`: 「使わない」・削除済みも含めて返す(変更履歴で過去の値を名前で出すため)。
 * このときだけ active と deleted(boolean)を足す。削除日時そのものや中身は返さない。
 */
export async function GET(request: Request) {
  try {
    await requireScenarioOptionsAccess();
    if (new URL(request.url).searchParams.get("includeInactive") === "1") {
      const rows = await prisma.dmScenario.findMany({
        select: { ...SCENARIO_OPTION_SELECT, ...LETTER_READY_SELECT, active: true, deletedAt: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      const scenarios = rows.map(({ deletedAt, ...r }) => ({
        ...withReady(r),
        deleted: deletedAt !== null,
      }));
      return NextResponse.json({ scenarios }, { headers: { "Cache-Control": "no-store" } });
    }
    const rows = await prisma.dmScenario.findMany({
      where: { active: true, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { ...SCENARIO_OPTION_SELECT, ...LETTER_READY_SELECT },
    });
    const scenarios = rows.map(withReady);
    return NextResponse.json({ scenarios }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
