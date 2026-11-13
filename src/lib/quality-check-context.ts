/**
 * 品質チェックの決まりのうち、毎回 DB から読む部分(2026-11-13 発注者「物件データエラー確認に表示」)。
 *
 * 外字(私用領域の字)が名前・登記上の住所・現住所のどれかにある所有者の id。
 * 取り込み・謄本の読み取り・手入力のどこから入っても、次に画面を開いたときに出る(入口ごとの仕掛けは要らない)。
 * ⚠返すのは所有者の id だけ(名前・住所は読み出さない)。保管(アーカイブ)した所有者は数えない。
 * ⚠物件の見える範囲(担当者だけ等)は呼び出し側の where で絞る。
 */
import prisma from "@/lib/prisma";
import { PRIVATE_USE_CLASS } from "@/lib/dm-batch/agent-name-exclusion";
import type { QualityContext } from "@/lib/quality-check-rules";

/** db = 呼び出し側の接続(一覧の条件作りが受け取る client をそのまま渡す)。 */
export async function loadQualityContext(
  db: { $queryRaw: typeof prisma.$queryRaw } = prisma,
): Promise<QualityContext> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT o.id::text AS id
    FROM owners o
    WHERE o.is_archived = false
      AND (coalesce(o.name, '') ~ ${PRIVATE_USE_CLASS}
        OR coalesce(o.address, '') ~ ${PRIVATE_USE_CLASS}
        OR coalesce(o.current_address, '') ~ ${PRIVATE_USE_CLASS})
  `;
  return { gaijiOwnerIds: rows.map((r) => r.id) };
}
