import { NextRequest } from "next/server";
import {
  ApiError,
  apiResponse,
  handleApiError,
  parseJsonBody,
} from "@/lib/api-helpers";
import {
  requireBulkSession,
  requireBulkPurchaseProvider,
} from "@/lib/registry-fetch/bulk/route-support";
import { createBulkFetchJob } from "@/lib/registry-fetch/bulk/jobs";

// ---------- POST /api/registry-fetch/jobs ----------
// 謄本の一括取得ジョブを作る(薄い版)。複数物件を選んで、種類(所有者事項/全部事項)を指定。
// 認可(registry:auto_fetch + property:read) → readiness(課金スイッチ+校正=501判定) →
// 可視物件だけを項目化(番号あり/所在不足は即 skipped・50件上限)を createBulkFetchJob に委譲する。
//
// body: { confirmed: true, propertyIds: string[], certificateType?: "owner"|"all" }
//
// ⚠課金スイッチ休眠中(REGISTRY_FETCH_PURCHASE_ENABLED 未設定)は 501=ジョブを作らせない。

export async function POST(request: NextRequest) {
  try {
    const session = await requireBulkSession();
    // 有料取得の readiness。未達ならここで 501(ジョブを作らせない・実サイトへ到達しない)。
    await requireBulkPurchaseProvider();

    const body = await parseJsonBody(request);
    const confirmed = (body as { confirmed?: unknown } | null)?.confirmed === true;
    if (!confirmed) {
      throw new ApiError(
        400,
        "一括取得には確認(confirmed:true)が必要です",
        "REGISTRY_BULK_CONFIRMATION_REQUIRED",
      );
    }

    const idsRaw = (body as { propertyIds?: unknown } | null)?.propertyIds;
    const propertyIds = Array.isArray(idsRaw)
      ? idsRaw.filter((x): x is string => typeof x === "string")
      : [];

    // 種別: 不正値は既定 owner に倒す(fail-safe: 未知の値で高い方を勝手に買わない)。
    const certRaw = (body as { certificateType?: unknown } | null)?.certificateType;
    const certificateType: "owner" | "all" = certRaw === "all" ? "all" : "owner";

    const result = await createBulkFetchJob({
      session,
      propertyIds,
      certificateType,
    });
    return apiResponse(result, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
