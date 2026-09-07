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
// - ページ送りは**キーセット方式**(`?after=<createdAt>_<id>`)。1回に MAX 件。
//   ⚠件数で数える方式(skip/offset)にしない。この一覧は上から順に片付ける作業
//   リストで、読んでいる最中に行が消える(物件化/却下)。消えた分だけ後続が
//   繰り上がり、**次のページで行が飛ぶ**=取りこぼし防止の画面で取りこぼしを作る。
//   判定は純関数 `field-survey-candidate-cursor.ts` に置き総当たりで検証している。
// - 応答の `truncated` は「まだ続きがある」の意味で**据え置き**(旧UIとの互換)。
//   新しい UI は `nextCursor` を使う。

import { CANDIDATE_LIST_LIMIT } from "@/lib/field-survey-candidate-util";
import {
  decodeCandidateCursor,
  candidateKeysetWhere,
  encodeCandidateCursor,
} from "@/lib/field-survey-candidate-cursor";

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

    // 並び順 (allowlist)。古いものから片付けたいときのため oldest を選べる
    // (Codex P2)。既定は newest。
    const params = new URL(request.url).searchParams;
    const orderKey = params.get("order") === "oldest" ? "oldest" : "newest";
    const order = orderKey === "oldest" ? "asc" : "desc";

    // 続きの位置。⚠壊れた指定を黙って「先頭から」に倒すと、利用者は同じページを
    //   延々と読み続けることになる(終わらない一覧)。必ず 400 で伝える。
    const rawAfter = params.get("after");
    const cursor = rawAfter === null ? null : decodeCandidateCursor(rawAfter);
    if (rawAfter !== null && cursor === null) {
      throw new ApiError(
        400,
        "続きの位置の指定が不正です。一覧を開き直してください",
        "VALIDATION_ERROR",
      );
    }
    const keyset = candidateKeysetWhere(cursor, orderKey);

    const rows = await prisma.fieldSurveyPin.findMany({
      where: {
        pinType: "candidate",
        status: "open",
        propertyId: null,
        ...(canSeeOthers ? {} : { staffUserId: session.id }),
        ...(keyset ?? {}),
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
      // ⚠カーソルの2段 (`candidateKeysetWhere`) と**同じ2段・同じ向き**。
      //   ここだけ変えると同時刻の行で取りこぼし/重複が出る。
      orderBy: [{ createdAt: order }, { id: order }],
      // ちょうど MAX 件と MAX+1 件以上を区別するため 1 件余分に取る
      // (件数一致だけでは「まだ続きがある」を誤判定する・Codex P2)。
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

    // 次の続きの位置。⚠**返した最後の行**から作る(切り捨てた MAX+1 件目では
    //   ない)。1件ずれると、その行が次のページで飛ぶ。
    const last = limited[limited.length - 1];
    const nextCursor =
      truncated && last
        ? encodeCandidateCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return apiResponse({ data, truncated, nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}
