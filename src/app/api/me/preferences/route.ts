import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { ApiError, getApiSession, getUserPermissions, handleApiError, apiResponse, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { appearancePatchSchema, parseAllowedThemes } from "@/lib/appearance/options";
import { loadCompanyAppearance, loadUserAppearance } from "@/lib/appearance/server";

// 見た目の設定(2026-10-31)。自分の 色テーマ・文字サイズ・レイアウト だけを読む/変える(ほかの人の設定には触れない)。
// 権限は「ログインしていること」だけ(自分の画面の見た目なので)。値は選択肢以外を受け付けない(422)。

const noStore = { "Cache-Control": "no-store" };

/**
 * GET と PATCH は同じ形で返す(画面は保存後の応答で表示を置き換える=印が欠けると管理者の欄が消える)。
 * canEditCompany: 設定 > 表示 の画面で「会社の標準」の欄を出すか(保存の権限は /api/admin/appearance-defaults で改めて確かめる)。
 */
async function preferencesResponse(userId: string) {
  const [appearance, perms] = await Promise.all([loadUserAppearance(userId), getUserPermissions(userId)]);
  const res = apiResponse({ data: { ...appearance, canEditCompany: hasPermission(perms, "user_management", "write") } });
  for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v);
  return res;
}

// ---------- GET /api/me/preferences ----------

export async function GET() {
  try {
    const session = await getApiSession();
    return await preferencesResponse(session.id);
  } catch (error) {
    return handleApiError(error);
  }
}

// ---------- PATCH /api/me/preferences ----------
// 本文: { theme?, density?, layout? }。null=会社の標準に戻す。

export async function PATCH(request: NextRequest) {
  try {
    const session = await getApiSession();
    const patch = appearancePatchSchema.parse(await parseJsonBody(request));
    // 会社が選べる色テーマを絞っているとき、許可外の色は保存しない(段階4・今は未設定=全部許可)。
    if (patch.theme && !parseAllowedThemes((await loadCompanyAppearance()).allowedThemes).includes(patch.theme)) {
      throw new ApiError(422, "この色テーマは会社の設定で選べません", "THEME_NOT_ALLOWED");
    }
    await prisma.user.update({ where: { id: session.id }, data: patch });
    return await preferencesResponse(session.id);
  } catch (error) {
    return handleApiError(error);
  }
}
