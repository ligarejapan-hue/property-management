import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// ============================================================
// GET /api/field-survey/pins/candidates
// ============================================================
// 事務所向け「物件化の完成待ち」一覧。物件化候補 × 未対応(open)× 未紐付けのピンを返す。
// - field_survey:read 必須。read_all / manage が無ければ own のみ
//   (= 変換エンドポイントの可視スコープと一致するので、返る候補は必ず変換可能)。
// - 座標(lat/lng/accuracy)・memo 本文は返さない(一覧は表示しない=非PII)。hasMemo のみ。
// - ページングは未対応。上限 MAX 件(通常運用では十分。超過時は古い分が出ない)。

const MAX = 200;

export async function GET() {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const canSeeOthers =
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");

    const rows = await prisma.fieldSurveyPin.findMany({
      where: {
        pinType: "candidate",
        status: "open",
        propertyId: null,
        ...(canSeeOthers ? {} : { staffUserId: session.id }),
      },
      select: { id: true, staffUserId: true, createdAt: true, memo: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX,
    });

    const data = rows.map((r) => ({
      id: r.id,
      staffUserId: r.staffUserId,
      createdAt: r.createdAt,
      hasMemo: typeof r.memo === "string" && r.memo.trim().length > 0,
    }));

    return apiResponse({ data });
  } catch (error) {
    return handleApiError(error);
  }
}
