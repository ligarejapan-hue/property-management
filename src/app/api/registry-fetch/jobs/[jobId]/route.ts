import { NextRequest } from "next/server";
import { apiResponse, handleApiError } from "@/lib/api-helpers";
import { requireBulkSession } from "@/lib/registry-fetch/bulk/route-support";
import { getBulkJobProgress } from "@/lib/registry-fetch/bulk/jobs";

// ---------- GET /api/registry-fetch/jobs/[jobId] ----------
// 一括ジョブの進捗。作成者本人のみ。⚠**毎回 可視項目でフィルタし件数を再計算**する
// (作成後に担当替え/削除された物件の処理結果を数字からも漏らさない)。PII 非露出 + no-store。

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await requireBulkSession();
    const progress = await getBulkJobProgress({ session, jobId });
    const res = apiResponse(progress, 200);
    // 物件を指す情報を含む=キャッシュさせない。
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    return handleApiError(error);
  }
}
