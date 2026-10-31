import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getApiSession, handleApiError, apiResponse, parseJsonBody } from "@/lib/api-helpers";
import { appearancePatchSchema } from "@/lib/appearance/options";
import { loadUserAppearance } from "@/lib/appearance/server";

// 見た目の設定(2026-10-31)。自分の 色テーマ・文字サイズ・レイアウト だけを読む/変える(ほかの人の設定には触れない)。
// 権限は「ログインしていること」だけ(自分の画面の見た目なので)。値は選択肢以外を受け付けない(422)。

const noStore = { "Cache-Control": "no-store" };

// ---------- GET /api/me/preferences ----------

export async function GET() {
  try {
    const session = await getApiSession();
    const res = apiResponse({ data: await loadUserAppearance(session.id) });
    for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v);
    return res;
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
    await prisma.user.update({ where: { id: session.id }, data: patch });
    const res = apiResponse({ data: await loadUserAppearance(session.id) });
    for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v);
    return res;
  } catch (error) {
    return handleApiError(error);
  }
}
