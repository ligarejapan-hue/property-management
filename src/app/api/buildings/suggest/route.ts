import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, getUserPermissions, ApiError, handleApiError, apiResponse } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { buildingNameKey } from "@/lib/building-identity";
import { rankBuildingSuggestions, SUGGEST_MIN_KEY_LENGTH } from "@/lib/building-link/suggest";

/** 1回に読む棟の上限(並べ替え前)。 */
const FETCH_LIMIT = 50;

// ---------- GET /api/buildings/suggest?name=…&area=… ----------
// ⚠area は画面が町丁目に丸めた値。番地つきの住所(address)は URL に載せない・読まない
//   (nginx 等の記録に残るため)。
// 物件名の入力欄の候補(設計 §5)。⚠棟の住所は町丁目までに丸めて返す。
export async function GET(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    if (!hasPermission(perms, "property", "read")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 100);
    const nameKey = buildingNameKey(name);
    if (!nameKey || nameKey.length < SUGGEST_MIN_KEY_LENGTH) return apiResponse({ data: [] });
    const area = (url.searchParams.get("area") ?? "").trim().slice(0, 100);
    const target = { nameKey, areaKey: area === "" ? null : area };
    const select = {
      id: true,
      name: true,
      address: true,
      nameKey: true,
      areaKey: true,
      createdAt: true,
      _count: { select: { properties: true } },
    } as const;
    // ⚠古い棟(nameKey が null)は名前に関係なく当たるので、別の枠で読む。
    //   同じ枠だと古い棟が読み込み枠を埋めて、同じ名前の棟が落ちる。
    // ⚠同じ名前(比較キー一致)の棟も別の枠で読む。部分一致と同じ枠だと、古い部分一致が
    //   50件を埋めて同じ名前の棟が落ちる。並べる順は 同じ名前 → 部分一致 → 古い棟。
    const [exact, keyed, legacy] = await Promise.all([
      prisma.building.findMany({
        where: { nameKey },
        select,
        take: FETCH_LIMIT,
        orderBy: { createdAt: "asc" },
      }),
      prisma.building.findMany({
        where: {
          OR: [
            { nameKey },
            { nameKey: { contains: nameKey } },
            { name: { contains: name, mode: "insensitive" } },
          ],
        },
        select,
        take: FETCH_LIMIT,
        orderBy: { createdAt: "asc" },
      }),
      prisma.building.findMany({
        where: { nameKey: null },
        select,
        take: FETCH_LIMIT,
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const seen = new Set<string>();
    const rows = [...exact, ...keyed, ...legacy].filter((b) => !seen.has(b.id) && seen.add(b.id));
    const filtered = rows.filter((b) => {
      const nk = b.nameKey ?? buildingNameKey(b.name);
      return nk === nameKey || b.name.toLowerCase().includes(name.toLowerCase()) || (nk ?? "").includes(nameKey);
    });
    const data = rankBuildingSuggestions(
      filtered.map((b) => ({ ...b, unitCount: b._count.properties })),
      target,
    );
    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
