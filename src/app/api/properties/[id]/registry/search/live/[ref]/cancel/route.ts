import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { canAccessPropertyRecord } from "@/lib/property-access";
import {
  isValidLiveRef,
  requestLiveViewCancel,
} from "@/lib/registry-fetch/live-view-store";

// ---------- POST /api/properties/[id]/registry/search/live/[ref]/cancel ----------
// 実況パネルの「中止」。発注者要望 (2026-08-03)。
//
// ⚠**フラグを立てるだけで、処理は殺さない**。外から強制終了すると外部サイトを
// 中途半端な状態 (カートに行だけ残る等) で放り出す恐れがあるため、実行中の
// provider が「安全な節目」で自分から止まる。
//
// ⚠**課金後は止まらない**(判断は provider 側 = cancel-safety.ts)。請求を押した後に
// 止めると「お金は払ったのに書類が手に入らない」状態を作る。この route は要求を
// 受け付けるだけで、止まるかどうかは provider が決める。
//
// 認可は GET (進行状況) と同一:
// - registry:auto_fetch + property:read
// - 物件スコープを再適用 (TTL 内の権限剥奪を即時反映)
// - ストアの key に userId を含むため、**他人の実行は止められない**
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; ref: string }> },
) {
  try {
    const { id, ref } = await params;
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "registry", "auto_fetch")) {
      throw new ApiError(403, "謄本所在検索の権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(permissions, "property", "read")) {
      throw new ApiError(403, "物件閲覧の権限がありません", "FORBIDDEN");
    }

    const property = await prisma.property.findUnique({
      where: { id },
      select: { id: true, createdBy: true, assignedTo: true },
    });
    if (!property) {
      throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
    }
    if (
      !canAccessPropertyRecord({ id: session.id, role: session.role }, property)
    ) {
      throw new ApiError(
        403,
        "この物件にアクセスする権限がありません",
        "FORBIDDEN",
      );
    }
    if (!isValidLiveRef(ref)) {
      throw new ApiError(404, "実況が見つかりません", "NOT_FOUND");
    }

    // 期限切れ / 別人 / 既に完了 なら false。いずれも「もう止める対象が無い」ので
    // 404 ではなく accepted:false を返し、パネル側は静かに閉じられる。
    const accepted = requestLiveViewCancel(session.id, id, ref);

    const res = apiResponse({ data: { accepted } });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (error) {
    return handleApiError(error);
  }
}
