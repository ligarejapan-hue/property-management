import { NextRequest } from "next/server";
import { apiResponse, handleApiError } from "@/lib/api-helpers";
import { requireBulkSession } from "@/lib/registry-fetch/bulk/route-support";
import { resumeBulkJob } from "@/lib/registry-fetch/bulk/jobs";

// ---------- POST /api/registry-fetch/jobs/[jobId]/resume ----------
// 一時停止(charged_but_failed 等)したジョブを再開する(作成者本人のみ)。
// paused → pending に戻し、残りの pending 項目を処理できるようにする。

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await requireBulkSession();
    const result = await resumeBulkJob({ session, jobId });
    return apiResponse(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
