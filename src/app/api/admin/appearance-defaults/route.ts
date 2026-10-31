import { NextResponse } from "next/server";
import { ApiError, getApiSession, getUserPermissions, handleApiError, parseJsonBody } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { companyAppearanceSchema } from "@/lib/appearance/options";
import { saveCompanyAppearance } from "@/lib/appearance/server";

// 見た目の設定 段階4(2026-10-31): 会社の標準(色・文字・配置)と選べる色テーマ。管理者(user_management:write)だけ。
// 読むのは GET /api/me/preferences(company・allowedThemes・canEditCompany)。個人が未設定(null)の人の見た目が変わる。

const NO_STORE = { "Cache-Control": "no-store" };

export async function PUT(request: Request) {
  try {
    const session = await getApiSession();
    if (!hasPermission(await getUserPermissions(session.id), "user_management", "write")) {
      throw new ApiError(403, "会社の標準を変更する権限がありません(管理者のみ)", "FORBIDDEN");
    }
    const input = companyAppearanceSchema.parse(await parseJsonBody(request));
    await saveCompanyAppearance(input);
    // 値は選択肢の名前だけ(個人情報なし)。targetId は UUID 列のため付けない(会社情報の設定と同じ)。
    await writeAuditLog({ userId: session.id, action: "appearance_defaults_update", targetTable: "system_settings", detail: input });
    return NextResponse.json({ data: input }, { headers: NO_STORE });
  } catch (error) {
    return handleApiError(error);
  }
}
