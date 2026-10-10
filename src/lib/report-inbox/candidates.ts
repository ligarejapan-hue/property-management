/**
 * 査定報告書の手がかり(マンション名・部屋番号・所在地)から、添付先の物件の候補を出す。
 *
 * ⚠**候補を出すだけで、自動では添付しない**(人が確かめて押す)。地番だけの突き合わせで
 *   別の区の物件へ誤リンクした事故(2026-09-10)の教訓。
 * いちばん強い手がかりは「マンション名(表記をそろえた形)+部屋番号」。所在地は書き方が
 * 揺れる(報告書「4丁目12ー3」・物件「4-12-3」)ので、ゆるい形で比べて補助に使う。
 */
import { Prisma } from "@/generated/prisma";
import { buildingNameKey } from "@/lib/building-identity";
import { addressSearchPrefix, toFullWidth } from "@/lib/paste-import/normalize";
import type { ReportClues } from "./extract";

export type CandidateMatch = "name_room" | "name" | "address_room" | "address";

export interface ReportCandidate {
  propertyId: string;
  address: string;
  buildingName: string | null;
  roomNo: string | null;
  propertyType: string;
  match: CandidateMatch;
}

export interface CandidateProperty {
  id: string;
  address: string;
  buildingName: string | null;
  roomNo: string | null;
  propertyType: string;
  buildingId: string | null;
  /** 担当の範囲の判定(canAccessPropertyRecord)に使う。 */
  createdBy?: string | null;
  assignedTo?: string | null;
}

/** 部屋番号の比べる形(全角半角・「号室」「号」・空白を吸収)。 */
export function roomKey(room: string | null | undefined): string | null {
  if (room == null) return null;
  const s = room.normalize("NFKC").replace(/\s/g, "").replace(/号室?$/, "");
  return s === "" ? null : s;
}

/**
 * 所在地のゆるい比べる形。「4丁目12ー3」「4-12-3」「4丁目12番3号」を同じにする。
 * ⚠先頭の郵便番号は外す。比べるだけに使い、保存はしない。
 */
export function addressLooseKey(address: string | null | undefined): string | null {
  if (address == null) return null;
  let s = address.normalize("NFKC").replace(/\s/g, "");
  s = s.replace(/^〒?\d{3}-?\d{4}/, "");
  s = s
    .replace(/[ー－−‐―–—]/g, "-")
    .replace(/(\d+)丁目/g, "$1-")
    .replace(/(\d+)番地?/g, "$1-")
    .replace(/(\d+)号/g, "$1")
    .replace(/-+/g, "-")
    .replace(/-$/, "");
  return s === "" ? null : s;
}

/** 部屋番号の書き方の揺れ(半角/全角 × なし/号/号室/空白+号室)。DB で完全一致に使う。 */
export function roomVariants(room: string): string[] {
  const out = new Set<string>();
  for (const r of [room, toFullWidth(room)]) {
    for (const suffix of ["", "号", "号室", " 号室", "　号室"]) out.add(`${r}${suffix}`);
  }
  return [...out];
}

/** 候補の順番: 名前+部屋 > 名前 > 所在地+部屋 > 所在地。 */
const ORDER: Record<CandidateMatch, number> = { name_room: 0, address_room: 1, name: 2, address: 3 };

/**
 * 読み込んだ物件から候補を決める(純関数)。
 * ⚠名前だけ一致(部屋違い)も出す=同じ棟の別の部屋に間違えて付けないよう、人が見て選ぶ。
 */
export function rankCandidates(
  clues: Pick<ReportClues, "buildingName" | "roomNo" | "address">,
  properties: readonly CandidateProperty[],
  limit = 10,
): ReportCandidate[] {
  const nameKey = buildingNameKey(clues.buildingName);
  const room = roomKey(clues.roomNo);
  const addr = addressLooseKey(clues.address);
  const out: ReportCandidate[] = [];
  const seen = new Set<string>();
  for (const p of properties) {
    if (seen.has(p.id)) continue;
    const nameHit = nameKey !== null && buildingNameKey(p.buildingName) === nameKey;
    const roomHit = room !== null && roomKey(p.roomNo) === room;
    const pAddr = addressLooseKey(p.address);
    // 物件の所在地は部屋番号や建物名まで含むことがあるので、前方一致で比べる。
    const addrHit = addr !== null && pAddr !== null && (pAddr === addr || pAddr.startsWith(addr));
    let match: CandidateMatch | null = null;
    if (nameHit) match = roomHit ? "name_room" : "name";
    else if (addrHit) match = roomHit ? "address_room" : "address";
    if (match === null) continue;
    seen.add(p.id);
    out.push({
      propertyId: p.id,
      address: p.address,
      buildingName: p.buildingName,
      roomNo: p.roomNo,
      propertyType: p.propertyType,
      match,
    });
  }
  return out.sort((a, b) => ORDER[a.match] - ORDER[b.match]).slice(0, limit);
}

/** DB から読む口(テストで差し替える)。 */
export interface CandidateDb {
  building: { findMany(args: unknown): Promise<{ id: string }[]> };
  property: { findMany(args: unknown): Promise<CandidateProperty[]> };
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * 名前の完全一致(比べる形)で物件 id を引く。複数の名前を**1回の問い合わせ**でまとめて引く
 * (一覧の1ページで報告書ごとに表を読み直さない・@codex PR#500 22巡目)。
 * DB 側も NFKC・小文字・空白なしにそろえる(PostgreSQL 13+)。名前ごとに念のための上限 2000。
 */
const EXACT_NAME_LIMIT = 2000;

export async function findExactNameIds(
  db: Pick<CandidateDb, "$queryRaw">,
  compacts: readonly string[],
): Promise<Map<string, string[]>> {
  const keys = [...new Set(compacts)];
  const out = new Map<string, string[]>();
  if (keys.length === 0) return out;
  // ⚠名前ごとの上限は **SQL の中で** かける(よくある名前で何万行も返して捨てない・23巡目)。
  const rows = await db.$queryRaw<{ id: string; k: string }[]>(Prisma.sql`
    SELECT y.id, y.k FROM (
      SELECT x.id, x.k, row_number() OVER (PARTITION BY x.k ORDER BY x.updated_at DESC, x.id) AS rn
      FROM (
        SELECT p.id, p.updated_at,
               lower(regexp_replace(normalize(p.building_name, NFKC), '[[:space:]　]', '', 'g')) AS k
        FROM "properties" p
        WHERE p.is_archived = false AND p.building_name IS NOT NULL
      ) x
      WHERE x.k = ANY(${keys})
    ) y
    WHERE y.rn <= ${EXACT_NAME_LIMIT}
  `);
  for (const r of rows) {
    const list = out.get(r.k) ?? [];
    list.push(r.id);
    out.set(r.k, list);
  }
  return out;
}

/** 名前の比べる形(NFKC・小文字・空白なし)。DB 側も同じ形(小文字・空白なし)にそろえて完全一致で引く。 */
export function compactNameForDb(name: string | null | undefined): string | null {
  if (name == null) return null;
  const s = name.normalize("NFKC").replace(/\s/g, "").toLowerCase();
  return s.length >= 2 ? s : null;
}

const PROPERTY_SELECT = {
  id: true,
  address: true,
  buildingName: true,
  roomNo: true,
  propertyType: true,
  buildingId: true,
  createdBy: true,
  assignedTo: true,
} as const;

/** 名前の比べる形が同じ棟・物件名・所在地の頭から、候補になりうる物件を読む。 */
export async function findReportCandidates(
  db: CandidateDb,
  clues: Pick<ReportClues, "buildingName" | "roomNo" | "address">,
  /**
   * ⚠呼び出した人が開ける物件だけを候補にする(担当外の住所・建物名を見せない・@codex PR#500)。
   * scopeWhere = DB で読むときの範囲(件数で切る前に効かせる)・canAccess = 読んだ後の念押し。
   */
  scope: {
    scopeWhere: Record<string, unknown>;
    canAccess: (p: CandidateProperty) => boolean;
    /** 名前の完全一致の結果(比べる形 → 物件 id)。一覧ではページ分をまとめて引いて渡す。 */
    exactNameIds?: ReadonlyMap<string, string[]>;
  },
): Promise<ReportCandidate[]> {
  const nameKey = buildingNameKey(clues.buildingName);
  const ors: unknown[] = [];
  let sameBuilding: unknown = null;
  let nameHead: unknown = null;
  let addressHead: unknown = null;
  if (nameKey !== null) {
    // ⚠棟は件数で切らない(同じ名前の棟が20を超えると目当ての棟が漏れる・@codex PR#500 19巡目)。
    const buildings = await db.building.findMany({ where: { nameKey }, select: { id: true } });
    if (buildings.length > 0) {
      sameBuilding = { buildingId: { in: buildings.map((b) => b.id) } };
      ors.push(sameBuilding);
    }
    // 棟につながっていない区分は物件名で探す(広めに取って、上で比べる形で絞る)。
    const head = (clues.buildingName ?? "").normalize("NFKC").replace(/\s/g, "").slice(0, 4);
    if (head.length >= 2) {
      nameHead = { buildingName: { contains: head, mode: "insensitive" } };
      ors.push(nameHead);
    }
  }
  const prefix = clues.address ? addressSearchPrefix(clues.address.normalize("NFKC")) : null;
  if (prefix) {
    addressHead = { address: { contains: prefix } };
    ors.push(addressHead);
  }
  if (ors.length === 0) return [];
  // ⚠広い条件(所在地の頭・名前の頭4文字)だけで件数を切ると、新しい物件が300件を超える地域では
  //   古い「名前+部屋」が一致する物件が読み込みから漏れる(@codex PR#500 14巡目)。
  //   強い一致になりうる組(部屋番号つき・棟の名前が一致)を**先に別々に**読み、最後に広い条件で補う。
  //   部屋番号は「含む」ではなく**書き方の揺れを並べた完全一致**で絞り、手がかりの種類ごとに分けて読む
  //   (同じ地域に「101」を含む部屋が300件を超えても、ぴったりの101号室が漏れない・15巡目)。
  // ⚠棟につながっていない物件は、名前の頭4文字の「含む」だけだと大文字小文字・途中の空白の違いで
  //   漏れ、件数の上限でも押し出される(19巡目)。**名前の完全一致**(小文字・空白なしにそろえる)を
  //   別の組として先に引く。完全一致は狭いので件数で切らない(念のための上限だけ)。
  //   DB 側も NFKC にそろえる(全角英数「ＡＢＣ」・半角カナで登録された物件も一致させる・20巡目。PostgreSQL 13+)。
  //   ⚠一覧の1ページ分は呼び出し側で**まとめて1回**引いて渡す(scope.exactNameIds・22巡目)。
  let sameName: unknown = null;
  const compact = compactNameForDb(clues.buildingName);
  if (compact !== null) {
    const ids = scope.exactNameIds
      ? (scope.exactNameIds.get(compact) ?? [])
      : ((await findExactNameIds(db, [compact])).get(compact) ?? []);
    if (ids.length > 0) sameName = { id: { in: ids } };
  }
  const room = roomKey(clues.roomNo);
  const groups: unknown[][] = [];
  const kinds = [sameBuilding, sameName, nameHead, addressHead].filter((c) => c !== null);
  if (room !== null) {
    const exactRoom = { roomNo: { in: roomVariants(room) } };
    for (const c of kinds) groups.push([c, exactRoom]);
  }
  for (const c of kinds) groups.push([c]);
  // 組どうしは独立なので**まとめて同時に**読む(順に待つと一覧1ページで往復が百回を超える・16巡目)。
  const results = await Promise.all(
    groups.map((conds) =>
      db.property.findMany({
        where: { AND: [{ isArchived: false }, ...conds, scope.scopeWhere] },
        select: PROPERTY_SELECT,
        take: 300,
        orderBy: { updatedAt: "desc" },
      }),
    ),
  );
  const seen = new Set<string>();
  const properties: CandidateProperty[] = [];
  for (const rows of results) {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      properties.push(r);
    }
  }
  return rankCandidates(clues, properties.filter(scope.canAccess));
}

/**
 * 手で探す。空白で区切った語を**すべて**含む物件(語ごとにマンション名・所在地・部屋番号のどれかに合えばよい)。
 * 例「東急ドエル 302」= 同じ建物の部屋が20件を超えても、部屋番号で目当ての部屋にたどり着ける
 * (@codex PR#500 6巡目: 名前だけだと新しい順の20件に入らない部屋を選べなかった)。
 * 全体で2文字以上。部屋番号は「号室」「号」を外して比べる。
 */
export function searchTerms(q: string): string[] {
  const all = q.normalize("NFKC").trim();
  if (all.length < 2) return [];
  return all.split(/\s+/).filter(Boolean).slice(0, 5);
}

export async function searchPropertiesForReport(
  db: Pick<CandidateDb, "property">,
  q: string,
  /** DB で読むときの担当の範囲(件数で切る前に効かせる・@codex PR#500 2巡目)。 */
  scopeWhere: Record<string, unknown>,
): Promise<CandidateProperty[]> {
  const terms = searchTerms(q);
  if (terms.length === 0) return [];
  return db.property.findMany({
    where: {
      AND: [
        { isArchived: false },
        ...terms.map((t) => {
          const room = t.replace(/号室?$/, "");
          return {
            OR: [
              { address: { contains: t, mode: "insensitive" } },
              { buildingName: { contains: t, mode: "insensitive" } },
              // ⚠部屋番号は「101」「１０１」「101号」「101 号室」など書き方がまちまち(@codex PR#500 10巡目)。
              //   半角・全角の両方で「含む」かを見る(建物名などの他の語と AND なので広がりすぎない)。
              ...(room !== ""
                ? [{ roomNo: { contains: room } }, { roomNo: { contains: toFullWidth(room) } }]
                : []),
            ],
          };
        }),
        scopeWhere,
      ],
    },
    select: PROPERTY_SELECT,
    take: 20,
    orderBy: { updatedAt: "desc" },
  });
}
