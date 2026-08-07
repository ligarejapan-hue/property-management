import { NextRequest } from "next/server";
import { apiResponse, handleApiError } from "@/lib/api-helpers";
import { requireBulkSession } from "@/lib/registry-fetch/bulk/route-support";
import { cancelBulkJob } from "@/lib/registry-fetch/bulk/jobs";

// ---------- POST /api/registry-fetch/jobs/[jobId]/cancel ----------
// ジョブを中止する(作成者本人のみ)。⚠節目で止まる=実行中の1件は最後まで進み
// (課金済みはそのまま)、新しい項目は掴まれない。

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const session = await requireBulkSession();
    const result = await cancelBulkJob({ session, jobId });
    return apiResponse(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
