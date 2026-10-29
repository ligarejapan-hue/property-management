import { apiResponse, handleApiError } from "@/lib/api-helpers";
import { requireBulkSession } from "@/lib/registry-fetch/bulk/route-support";
import { getMonthlyPurchaseUsage } from "@/lib/registry-fetch/monthly-cap-store";

// ---------- GET /api/registry-fetch/monthly-usage ----------
// 謄本の有料取得の「今月の利用額」(2026-10-29 月の上限=5万円)。
// 取得ボタンの近く・一括取得の画面に「今月の有料取得 ◯円/50,000円」を出し、
// 上限に達したらボタンを押せなくするための材料(読み取りのみ・副作用なし)。
//
// - ゲート: registry:auto_fetch + property:read(単発/一括の取得routeと同型)。
// - 返すのは金額と上限・値段だけ(物件・地番・利用者は返さない)。
// - ⚠画面の表示は目安。**本物の判定は課金の直前**(runRegistryAutoFetch の予約)。

export async function GET() {
  try {
    await requireBulkSession();
    const usage = await getMonthlyPurchaseUsage();
    return apiResponse(usage);
  } catch (error) {
    return handleApiError(error);
  }
}
