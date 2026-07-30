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
export type PropertyRecordScope = {
  OR: [{ createdBy: string }, { assignedTo: string }];
};

/** $transaction のコールバックが受け取るクライアント（$queryRaw だけ使う）。 */
type TxLike = {
  $queryRaw: <T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

/**
 * トランザクション内で**物件行をロックしつつ**担当者スコープを確認する。
 *
 * 【この差分の書き込み規約 = これ1文】
 * **物件配下のデータを書き換えるトランザクションは、必ず最初にこれを呼ぶ。**
 * （@codex #338 R4 で作成経路に導入し、R7 の指摘で更新/削除にも統一した）
 *
 * ⚠**リレーション述語（`property: scope`）だけでは窓が閉じない**。子テーブルの
 * updateMany に親のリレーション条件を付けても、**親の `properties` 行はロック
 * されない**。Postgres の既定 READ COMMITTED では文の開始時点のスナップショットで
 * 親を読むため、担当の付け替えがその直後に commit されると、古い担当のまま
 * 1 件更新が通ってしまう（更新対象の行が別なので両方 commit できる）。
 * `SELECT … FOR UPDATE` で親行をロックすれば、付け替えはこの tx の commit まで
 * 待たされる。0 件 = ロック時点で担当外（または物件が無い）→ 403。
 *
 * ⚠リレーション述語は**残す**（ロックが主・述語は多層防御）。ロックの呼び忘れが
 * あっても述語が窓を1文に狭める。両方あることをテストで固定している。
 * ⚠ロックは常に「親の物件 → 子の行」の順で取る（全経路で同じ順序 = デッドロック回避）。
 *
 * ⚠`updatedAt` を触る「touch」方式は採らない。物件の更新日時が
 *   コメント追加のような別操作で動くと、一覧の「更新日」が意味を失う。
 * ⚠スコープは生 SQL でもパラメータだけで表現する（既存の前例 =
 *   properties/[id]/candidates/route.ts:291-293 と同じ形）。
 *   scopeUserId が NULL（admin / office_staff）なら条件は素通り。
 * ⚠**存在しない物件の 404 は呼び出し側の assertPropertyRecordAccess が担う**
 *   （ロックでは 404 と 403 を区別できないため、先にそちらを通しておく）。
 */
export async function lockPropertyRecordForWrite(
  tx: TxLike,
  propertyId: string,
  session: { id: string; role: string },
): Promise<void> {
  const scopeUserId = session.role === "field_staff" ? session.id : null;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM properties
    WHERE id = ${propertyId}::uuid
      AND (
        ${scopeUserId}::uuid IS NULL
        OR created_by = ${scopeUserId}::uuid
        OR assigned_to = ${scopeUserId}::uuid
      )
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new ApiError(
      403,
      "この物件を操作する権限がありません",
      "FORBIDDEN",
    );
  }
}

export function propertyRecordScopeFilter(session: {
  id: string;
  role: string;
}): PropertyRecordScope | undefined {
  if (session.role !== "field_staff") return undefined;
  return { OR: [{ createdBy: session.id }, { assignedTo: session.id }] };
}
