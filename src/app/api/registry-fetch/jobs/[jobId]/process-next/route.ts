import { NextRequest } from "next/server";
import { apiResponse, handleApiError } from "@/lib/api-helpers";
import {
  requireBulkSession,
  requireBulkPurchaseProvider,
} from "@/lib/registry-fetch/bulk/route-support";
import { processNextBulkItem } from "@/lib/registry-fetch/bulk/process";

// ---------- POST /api/registry-fetch/jobs/[jobId]/process-next ----------
// 画面駆動の分割実行: pending 項目を1件だけ処理する。認可 + readiness(課金スイッチ+校正)を
// 単発取得と同じ基準で門し、provider を processNextBulkItem に注入する。
// ⚠サーバー常駐の無人実行にはしない(お金が動く処理=画面が1件ずつ叩く)。

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await requireBulkSession();
    const provider = await requireBulkPurchaseProvider();
    const result = await processNextBulkItem({ session, jobId, provider });
    const res = apiResponse(result, 200);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    return handleApiError(error);
  }
}
