/**
 * 業者と同じ名前の所有者には DM を送らない(2026-11-09 発注者指示)。
 *
 * 「反響の受付で作った業者の一覧」= 業者の名簿(agents・使っているものだけ)と国交省の業者一覧(mlit_agents・全行)。
 * 所有者の名前がどちらかの会社名と同じなら、**住所に関係なく**その所有者が絡む宛先を外す。
 * 個人で免許を持つ業者(会社名が個人の名前)も含めて照合する=同姓同名の一般の方も外れる(発注者判断 11-09)。
 *
 * 名前のそろえ方(両側に同じ式を SQL で当てる=そろえ方の定義はこの1か所):
 *   NFKC(全角/半角・㈱→(株))→ 空白を全部除く → 小文字 → (株)/(有)/(同) を 株式会社/有限会社/合同会社 に
 *   → よくある異体字(NAME_VARIANTS: 髙→高 など)をそろえる。そろえた結果が完全に同じときだけ一致。
 *   空の名前は一致にしない。
 *
 * ⚠国交省の一覧は約5万行。所有者側を先に絞り、業者側は `IN (SELECT …)` でまとめて1回だけ正規化させる
 *   (行ごとの相関 EXISTS にすると所有者×5万回の正規化になる)。
 * ⚠業者の一覧の更新と DM 作成は直列化しない(拒否・宛先不明とは違い、遅れて載った業者は次の判定で外れる)。
 *
 * 2026-11-11: 名前に謄本の外字(私用領域の字)がある所有者も、同じ SQL で見つけて外す(宛名が □ になる・
 * 外字のまま自動で登録された同じ方に2通届く)。件数は理由ごとに分けて見せる。
 * 2026-11-13(発注者 案A): 実際に刷る住所(現住所があれば現住所・無ければ登記上の住所)に外字がある所有者も外す。
 */

import { Prisma } from "@/generated/prisma";
import { NAME_VARIANTS } from "@/lib/deals/crosscheck";

const VARIANT_FROM = Object.keys(NAME_VARIANTS).join("");
const VARIANT_TO = Object.values(NAME_VARIANTS).join("");

/** 列の値をそろえる SQL の式(所有者と業者の両側に同じものを当てる)。 */
export function agentNameKeySql(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(replace(replace(replace(lower(regexp_replace(normalize(coalesce(${column}, ''), NFKC), '\\s+', '', 'g')), '(株)', '株式会社'), '(有)', '有限会社'), '(同)', '合同会社'), ${VARIANT_FROM}, ${VARIANT_TO})`;
}

/** tx に要求する最小の形(実 Prisma tx / route テストの mock の両方が満たす)。 */
export interface AgentNameExclusionTx {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * 業者と同じ名前の所有者の id を返す。ownerIds が空なら DB を引かない。
 */
export async function findAgentNameOwnerIds(
  tx: AgentNameExclusionTx,
  ownerIds: readonly string[],
): Promise<Set<string>> {
  return (await findOwnerNameExclusions(tx, ownerIds)).agentOwnerIds;
}

/** 名前で DM から外す所有者(理由ごと)。 */
export interface OwnerNameExclusions {
  /** 業者と同じ名前 */
  agentOwnerIds: Set<string>;
  /** 名前か実際に刷る住所に謄本の外字(私用領域の字)がある=宛名が □ になる(2026-11-11 実機確認・住所は 11-13) */
  gaijiOwnerIds: Set<string>;
}

/**
 * 名前で DM から外す所有者を、業者と同じ名前・外字の名前に分けて返す(SQL は1本)。
 * ownerIds が空なら DB を引かない。
 */
export async function findOwnerNameExclusions(
  tx: AgentNameExclusionTx,
  ownerIds: readonly string[],
): Promise<OwnerNameExclusions> {
  const all = [...new Set(ownerIds)].sort();
  const found: OwnerNameExclusions = { agentOwnerIds: new Set(), gaijiOwnerIds: new Set() };
  // 物件住所宛 CSV は最大1万物件=所有者が数万人になり得る。1回の SQL の引数の上限(65535)に届かないよう分ける。
  for (let i = 0; i < all.length; i += OWNER_CHUNK) {
    for (const r of await findChunk(tx, all.slice(i, i + OWNER_CHUNK))) {
      // agent の列が無い行(古い形)は業者と同じ名前として扱う
      if (r.agent !== false) found.agentOwnerIds.add(r.id);
      if (r.gaiji === true) found.gaijiOwnerIds.add(r.id);
    }
  }
  return found;
}

const OWNER_CHUNK = 10_000;

/** 私用領域(U+E000〜U+F8FF)の字の範囲(正規表現の文字クラス・値として SQL に渡す)。 */
export const PRIVATE_USE_CLASS = `[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}]`;

/**
 * 実際に刷る住所(resolveMailingAddress と同じ決め方): 現住所が空白だけでなければ現住所、そうでなければ登記上の住所。
 * 空白 = JS の trim と同じ範囲(半角・全角の空白・タブ・改行・NBSP・BOM・U+2000〜U+200A・行区切りなど)。
 */
function mailingAddressSql(): Prisma.Sql {
  return Prisma.sql`(CASE WHEN regexp_replace(coalesce(o.current_address, ''), ${BLANK_CLASS}, '', 'g') <> '' THEN o.current_address ELSE coalesce(o.address, '') END)`;
}

// \s に入らない空白(全角空白・NBSP・BOM・U+2000〜U+200A・行/段落区切り・U+202F・U+205F)も足す(内部レビュー P3)。
const BLANK_CLASS = `[\\s${String.fromCharCode(0x3000, 0x00a0, 0xfeff, 0x2028, 0x2029, 0x202f, 0x205f)}${String.fromCharCode(0x2000)}-${String.fromCharCode(0x200a)}]`;

async function findChunk(
  tx: AgentNameExclusionTx,
  ids: string[],
): Promise<{ id: string; agent?: boolean; gaiji?: boolean }[]> {
  const ownerKey = agentNameKeySql(Prisma.sql`o.name`);
  const agentKey = agentNameKeySql(Prisma.sql`a.company_name`);
  const mlitKey = agentNameKeySql(Prisma.sql`m.company_name`);
  return tx.$queryRaw<{ id: string; agent: boolean; gaiji: boolean }[]>(Prisma.sql`
    WITH k AS (
      SELECT o.id::text AS id, ${ownerKey} AS key,
        (coalesce(o.name, '') ~ ${PRIVATE_USE_CLASS} OR ${mailingAddressSql()} ~ ${PRIVATE_USE_CLASS}) AS gaiji
      FROM owners o
      WHERE o.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ), r AS (
      SELECT k.id, k.gaiji,
        (k.key <> ''
          AND (
            k.key IN (SELECT ${agentKey} FROM agents a WHERE a.is_archived = false)
            OR k.key IN (SELECT ${mlitKey} FROM mlit_agents m)
          )) AS agent
      FROM k
    )
    SELECT r.id, r.agent, r.gaiji FROM r WHERE r.agent OR r.gaiji
  `);
}
