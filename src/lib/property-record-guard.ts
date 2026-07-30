import prisma from "@/lib/prisma";
import { ApiError } from "@/lib/api-helpers";
import { canAccessPropertyRecord } from "@/lib/property-access";

/**
 * 物件配下の API で **担当者スコープ**（field_staff は自分が作成 or 担当の物件のみ）を
 * DB 読み取りつきで強制する共通ガード。
 *
 * 【なぜ必要か】物件本体 (GET/PATCH /api/properties/[id]) は担当分だけに絞るのに、
 * 配下のコメント・次アクション・調査情報などは絞っておらず、**同じ物件なのに
 * 経路によって見える範囲が違う**状態だった（認可・PII 横断監査 2026-07-30）。
 * 発注者判断（2026-07-30）:
 *   **「担当外に見せてよいのは地図上の線・ヒートマップだけ。顧客の情報は話が違う」**
 *   → 物件・顧客に紐づくデータは**物件本体と同じ担当分だけ**に揃える。
 * ⚠踏破の面（coverage/cells）と線（coverage/tracks）は**この対象外**。全員が
 *   見られる設計を意図的に維持する（二度歩きを避けるのが目的の機能なので、
 *   歩く当人が他の人の踏破を見られないと意味がない）。
 *
 * 【使い方】権限 (property:read / write) の判定を通した**直後**に呼ぶ。
 * 物件の存在確認も兼ねるので、これを呼べば個別の findUnique + 404 は不要。
 *
 * ⚠404 と 403 の順序は既存 route と同じ「存在しなければ 404 → スコープ外は 403」に
 * 揃える。逆にすると担当外の物件について「存在するか」だけが漏れる。
 * ⚠admin / office_staff は素通し（canAccessPropertyRecord の定義どおり）。
 * スコープ条件を変えるときは canAccessPropertyRecord 側と必ず同時に更新する。
 *
 * ---
 * ⚠**認可はリクエスト受付時点のスナップショットで評価する**（@codex #338 P2 への
 * 明示的な設計判断）。この判定と後続のクエリは同一トランザクションではないため、
 * 「判定を通った直後に担当が付け替えられる」ミリ秒の窓は残る。これは
 *   - 揃え先である物件本体 (GET/PATCH /api/properties/[id]) も同じ形であり、
 *     ここだけ原子化すると**このPRが解消しようとした不揃いを作り直す**
 *   - その窓で読めるのは「1ミリ秒前まで正当に読めたもの」で、権限の昇格ではない
 * ため設計として受容する。読み取り側まで原子化するには全ての子クエリに
 * スコープ述語を通す必要があり、それは横断的な設計変更として別途判断する。
 *
 * ただし**永続する書き込み**は結果が残るため、下記 propertyRecordScopeFilter を
 * 使って**操作自体の where にスコープを畳み込む**（updateMany / deleteMany の
 * 0 件を 403 に落とす）。読み取りは受付時点判定、書き込みは原子的、が本ファイルの
 * 契約である。
 */
export async function assertPropertyRecordAccess(
  propertyId: string,
  session: { id: string; role: string },
  /** エラー文言の出し分け。読み取り系は "read"、更新系は "write"（既定）。 */
  intent: "read" | "write" = "write",
): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { createdBy: true, assignedTo: true },
  });
  if (!property) {
    throw new ApiError(404, "物件が見つかりません", "NOT_FOUND");
  }
  if (!canAccessPropertyRecord(session, property)) {
    throw new ApiError(
      403,
      intent === "read"
        ? "この物件を閲覧する権限がありません"
        : "この物件を操作する権限がありません",
      "FORBIDDEN",
    );
  }
}

/**
 * 子レコードの更新・削除の `where` に畳み込むための**物件スコープ述語**。
 *
 * 用途: `prisma.nextAction.updateMany({ where: { id, property: scope } })` のように
 * 使い、**0 件なら 403**（= 判定から書込までの間に担当が外れた／別物件の子だった）。
 * これで書き込みは check-then-write ではなく1文で原子的になる（@codex #338 P2）。
 *
 * 戻り値が undefined（field_staff 以外）のときは条件を積まない。
 * ⚠スコープ条件は canAccessPropertyRecord と同じ定義に保つこと。
 */
export function propertyRecordScopeFilter(session: {
  id: string;
  role: string;
}): { OR: [{ createdBy: string }, { assignedTo: string }] } | undefined {
  if (session.role !== "field_staff") return undefined;
  return { OR: [{ createdBy: session.id }, { assignedTo: session.id }] };
}
