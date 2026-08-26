import { NextRequest } from "next/server";
import {
  getApiSession,
  getUserPermissions,
  ApiError,
  handleApiError,
  apiResponse,
} from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import { assertImportJsonBodySize } from "@/lib/import-body-size";
import { lookupPasteDuplicates } from "@/lib/paste-import-duplicates";
import { normalizeExternalLinkKey } from "@/lib/paste-import/normalize";

// ---------- POST /api/import/paste/recheck ----------
//
// 確認画面で人が住所・地番・査定ナンバー・所有者の氏名/現住所を**直したあと**に、
// 重複の見立てをやり直す口。
//
// ⚠なぜ要るか(@codex PR#414 6巡目 ②③):
//   これまで duplicates / similar / ownerCandidates は**最初の読み取り結果のまま**で、
//   人が直した結果が既存と一致しても警告が出なかった。
//   ・住所の重複は**登録APIが意図的にブロックしない**(人が判断すべきなので)ため、
//     画面の警告が**唯一の防御線**。直したら効かない、では防御にならない。
//   ・読み取りが崩れた氏名を既存所有者の正しい氏名に直した瞬間こそ候補が出るべきで、
//     出ないと既存の人がいるのに新しい所有者が作られる。
//
// ⚠判定も、権限・表示レベル・レコードスコープの扱いも、**下書きAPIと同じ関数**
//   (lookupPasteDuplicates) に閉じ込めている。ここで独自に書かない。
//
// ⚠この口は**何も保存しない**。貼った原文も受け取らない。

/** この口が受け取るのは短い項目だけ。共有の既定(64MB)ではなく専用の上限を掛ける。 */
const MAX_RECHECK_JSON_BODY_BYTES = 256 * 1024;

interface RecheckBody {
  address?: string | null;
  lotNumber?: string | null;
  externalLinkKey?: string | null;
  ownerName?: string | null;
  ownerCurrentAddress?: string | null;
}

/** 空文字は「無い」と同じに畳む(下書き側の値と同じ扱いにする)。 */
function orNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getApiSession();
    const perms = await getUserPermissions(session.id);
    // ⚠下書きAPIと**同じゲート・同じ順序・同じ文言**。
    if (!hasPermission(perms, "import", "write")) {
      throw new ApiError(403, "権限がありません", "FORBIDDEN");
    }
    if (!hasPermission(perms, "property", "write")) {
      throw new ApiError(403, "物件を作る権限がありません", "FORBIDDEN");
    }

    assertImportJsonBodySize(request, MAX_RECHECK_JSON_BODY_BYTES);
    const body = (await request.json()) as RecheckBody;

    const result = await lookupPasteDuplicates(session, perms, {
      address: orNull(body.address),
      lotNumber: orNull(body.lotNumber),
      // ⚠**下書き・確定と同じ関数で正規化する**(@codex PR#414 16巡目 ②)。
      //   ここだけ生値で引いていたため、利用者が査定ナンバーを全角に直すと
      //   recheck は「重複なし」と言い、commit は正規化して 409 を返す＝
      //   画面の最終確認と実際の結果が食い違っていた。
      //   3ルートが同じ関数を通ることは走査テストで固定してある。
      externalLinkKey: normalizeExternalLinkKey(orNull(body.externalLinkKey)),
      ownerName: orNull(body.ownerName),
      ownerCurrentAddress: orNull(body.ownerCurrentAddress),
    });

    return apiResponse(result);
  } catch (error) {
    return handleApiError(error);
  }
}
