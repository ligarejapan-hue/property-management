import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, apiResponse, getApiSession, getUserPermissions, handleApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { adoptCatalogBuilding, type AdoptTx } from "@/lib/mansion-catalog/adopt";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/mansion-catalog/:id/adopt — 名簿の建物をマンション棟にする(設計 2026-10-18 §6.3)。 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "write")) throw new ApiError(403, "権限がありません", "FORBIDDEN");
    const { id } = await params;
    // uuid でない値を DB に渡すと型のエラー(500)になるので、ここで「見つからない」にする。
    if (!UUID_RE.test(id)) throw new ApiError(404, "名簿の建物が見つかりません", "NOT_FOUND");
    const r = await prisma.$transaction((tx) => adoptCatalogBuilding(tx as unknown as AdoptTx, id, session.id));
    if (r.kind === "not_found" || r.kind === "none") throw new ApiError(404, "名簿の建物が見つかりません", "NOT_FOUND");
    if (r.kind === "ambiguous") {
      throw new ApiError(409, "同じ名前の棟が複数あります。マンション棟の一覧から選んでください", "CATALOG_AMBIGUOUS");
    }
    return apiResponse({ buildingId: r.building.id, kind: r.kind });
  } catch (error) {
    return handleApiError(error);
  }
}
