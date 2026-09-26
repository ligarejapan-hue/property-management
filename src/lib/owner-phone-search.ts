/**
 * 所有者の電話番号を「数字だけ」で探す(ハイフンの有無・打ちかけの番号でも当たる)。
 * properties/suggest と同じ方式(regexp_replace は index が効かないので 7 桁以上・件数上限つき)。
 * ⚠呼び出し側は「電話を生値で見られる利用者」のときだけ呼ぶこと(検索オラクル封じ)。
 */
import prisma from "@/lib/prisma";

const PHONE_OWNER_LIMIT = 100;

export async function findOwnerIdsByPhoneDigits(digits: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "owners"
    WHERE regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}
    LIMIT ${PHONE_OWNER_LIMIT}
  `;
  return rows.map((r) => r.id);
}
