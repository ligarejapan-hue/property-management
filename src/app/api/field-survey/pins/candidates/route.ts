import prisma from "@/lib/prisma";
import {
  getApiSession,
  getUserPermissions,
  apiResponse,
  handleApiError,
  ApiError,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { normalizeFileUrl } from "@/lib/url-normalize";

// ============================================================
// GET /api/field-survey/pins/candidates
// ============================================================
// 事務所向け「物件化の完成待ち」一覧。物件化候補 × 未対応(open)× 未紐付けのピンを返す。
// - field_survey:read 必須。read_all / manage が無ければ own のみ
//   (= 変換エンドポイントの可視スコープと一致するので、返る候補は必ず変換可能)。
// - 座標(lat/lng/accuracy)・memo 本文は返さない(一覧は表示しない=非PII)。hasMemo のみ。
// - 「場所特定」の手がかりとして現地写真の cover サムネイル URL と枚数は返す。
//   写真は upload 時に EXIF/GPS strip 済 + /uploads 配信は認可ゲート済(own は
//   field_survey:read、他人は read_all/manage)で、一覧の可視スコープと一致する
//   ため PII 境界を広げない(座標・memo 本文は依然返さない)。
// - ページングは未対応。上限 MAX 件(通常運用では十分。超過時は古い分が出ない。
//   UI 側は件数が上限に達したら「古い候補が表示されていない」警告を出す)。

import { CANDIDATE_LIST_LIMIT } from "@/lib/field-survey-candidate-util";

const MAX = CANDIDATE_LIST_LIMIT;

export async function GET(request: Request) {
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);

    if (!hasPermission(permissions, "field_survey", "read")) {
      throw new ApiError(403, "閲覧権限がありません", "FORBIDDEN");
    }

    const canSeeOthers =
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");

    // 並び順 (allowlist)。上限超過時に「古い候補へ到達できない」を防ぐため
    // oldest (古い順) を選べるようにする (Codex P2)。既定は newest。
    const order =
      new URL(request.url).searchParams.get("order") === "oldest"
        ? "asc"
        : "desc";

    const rows = await prisma.fieldSurveyPin.findMany({
      where: {
        pinType: "candidate",
        status: "open",
        propertyId: null,
        ...(canSeeOthers ? {} : { staffUserId: session.id }),
      },
      select: {
        id: true,
        staffUserId: true,
        createdAt: true,
        memo: true,
        // cover 写真 (sortOrder 昇順の先頭 = 表紙) 1 件だけ。thumbnailUrl が
        // 無ければ原本 fileUrl に fallback して一覧側で表示する。
        photos: {
          select: { fileUrl: true, thumbnailUrl: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          take: 1,
        },
        _count: { select: { photos: true } },
      },
      orderBy: [{ createdAt: order }, { id: order }],
      // 上限ちょうど (=MAX 件) と超過 (=MAX+1 件以上) を区別するため 1 件
      // 余分に取得し、truncated フラグで「古い候補が表示されていない」を
      // 正確に伝える (Codex P2: 件数一致だけでは誤警告になる)。
      take: MAX + 1,
    });

    const truncated = rows.length > MAX;
    const limited = truncated ? rows.slice(0, MAX) : rows;
    const data = limited.map((r) => {
      const cover = r.photos[0];
      const coverPhotoUrl = cover
        ? normalizeFileUrl(cover.thumbnailUrl ?? cover.fileUrl)
        : null;
      return {
        id: r.id,
        staffUserId: r.staffUserId,
        createdAt: r.createdAt,
        hasMemo: typeof r.memo === "string" && r.memo.trim().length > 0,
        // 場所特定の手がかり。座標・memo 本文は依然返さない。
        coverPhotoUrl,
        photoCount: r._count.photos,
      };
    });

    return apiResponse({ data, truncated });
  } catch (error) {
    return handleApiError(error);
  }
}
