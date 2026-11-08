/**
 * まだ比べていない(比べ直しが要る)物件の謄本を読んで、名義を比べる(管理者だけ)。
 * 1回に REGISTRY_OWNER_CHECK_RUN_MAX 件まで。画面が残りが0になるまで繰り返し呼ぶ。
 * ⚠返すのは結果ごとの件数だけ(氏名・物件は返さない)。
 */
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { writeAuditLog } from "@/lib/audit";
import { findMissingRegistryOwnerReviewPerm } from "@/lib/registry-owner-check/permissions";
import {
  REGISTRY_OWNER_CHECK_RUN_MAX,
  runRegistryOwnerChecks,
} from "@/lib/registry-owner-check/service";

export async function POST(request: Request) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    const missing = findMissingRegistryOwnerReviewPerm(perms, "run");
    if (missing) throw new ApiError(403, missing, "FORBIDDEN");

    const body = (await request.json().catch(() => null)) as { limit?: unknown } | null;
    const raw = Number(body?.limit);
    const limit = Number.isFinite(raw) && raw >= 1 ? raw : REGISTRY_OWNER_CHECK_RUN_MAX;

    const outcome = await runRegistryOwnerChecks(limit);
    if (outcome.processed > 0) {
      await writeAuditLog({
        userId: session.id,
        action: "registry_owner_check_run",
        targetTable: "registry_owner_checks",
        detail: { processed: outcome.processed, failed: outcome.failed, counts: outcome.counts },
      });
    }
    return apiResponse(outcome);
  } catch (error) {
    return handleApiError(error);
  }
}
