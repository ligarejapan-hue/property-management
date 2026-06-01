import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
  parseJsonBody,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { runRegistryAutoFetch } from "@/lib/registry-fetch/auto-fetch";

// ---------- POST /api/properties/[id]/registry/auto-fetch ----------
// 謄本自動取得（PR4・mock provider のみ）。本番外部接続・Playwright・課金・env 追加・
// 一括取得は無し。認証 → 権限（registry:auto_fetch + property:read）→ 入力受け口
// （confirmed）だけを担当し、取得・取込・registryStatus 遷移・AuditLog は
// runRegistryAutoFetch（@/lib/registry-fetch/auto-fetch）へ委譲する。
//
// body: { confirmed: true }  // 課金確認。true 以外は実行されない（400）。
//
// 本 route は POST handler のみを export する。

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    // registry:auto_fetch（admin のみ付与・課金を伴う高リスク操作）。
    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本自動取得の権限がありません", "FORBIDDEN");
    }
    // 物件情報を読む既存権限も要求する（property:read）。
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    // 課金確認フラグ。空ボディ / JSON 不正は parseJsonBody が安全に処理する。
    const body = await parseJsonBody(request);
    const confirmed = (body as { confirmed?: unknown }).confirmed === true;

    const result = await runRegistryAutoFetch({
      session: { id: session.id, role: session.role },
      propertyId: id,
      confirmed,
    });

    return apiResponse(result, 200);
  } catch (error) {
    return handleApiError(error);
  }
}
