/**
 * 査定報告書の手がかり(マンション名・部屋番号・所在地)から、添付先の物件の候補を出す。
 *
 * ⚠**候補を出すだけで、自動では添付しない**(人が確かめて押す)。地番だけの突き合わせで
 *   別の区の物件へ誤リンクした事故(2026-09-10)の教訓。
 * いちばん強い手がかりは「マンション名(表記をそろえた形)+部屋番号」。所在地は書き方が
 * 揺れる(報告書「4丁目12ー3」・物件「4-12-3」)ので、ゆるい形で比べて補助に使う。
 */
import { buildingNameKey } from "@/lib/building-identity";
import { addressSearchPrefix } from "@/lib/paste-import/normalize";
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
}

const PROPERTY_SELECT = {
  id: true,
  address: true,
  buildingName: true,
  roomNo: true,
  propertyType: true,
  buildingId: true,
} as const;

/** 名前の比べる形が同じ棟・物件名・所在地の頭から、候補になりうる物件を読む。 */
export async function findReportCandidates(
  db: CandidateDb,
  clues: Pick<ReportClues, "buildingName" | "roomNo" | "address">,
): Promise<ReportCandidate[]> {
  const nameKey = buildingNameKey(clues.buildingName);
  const ors: unknown[] = [];
  if (nameKey !== null) {
    const buildings = await db.building.findMany({ where: { nameKey }, select: { id: true }, take: 20 });
    if (buildings.length > 0) ors.push({ buildingId: { in: buildings.map((b) => b.id) } });
    // 棟につながっていない区分は物件名で探す(広めに取って、上で比べる形で絞る)。
    const head = (clues.buildingName ?? "").normalize("NFKC").replace(/\s/g, "").slice(0, 4);
    if (head.length >= 2) ors.push({ buildingName: { contains: head } });
  }
  const prefix = clues.address ? addressSearchPrefix(clues.address.normalize("NFKC")) : null;
  if (prefix) ors.push({ address: { contains: prefix } });
  if (ors.length === 0) return [];
  const properties = await db.property.findMany({
    where: { isArchived: false, OR: ors },
    select: PROPERTY_SELECT,
    take: 300,
    orderBy: { updatedAt: "desc" },
  });
  return rankCandidates(clues, properties);
}

/** 手で探す(マンション名・所在地のどちらでも)。2文字以上。 */
export async function searchPropertiesForReport(
  db: Pick<CandidateDb, "property">,
  q: string,
): Promise<CandidateProperty[]> {
  const term = q.normalize("NFKC").trim();
  if (term.length < 2) return [];
  return db.property.findMany({
    where: {
      isArchived: false,
      OR: [
        { address: { contains: term, mode: "insensitive" } },
        { buildingName: { contains: term, mode: "insensitive" } },
      ],
    },
    select: PROPERTY_SELECT,
    take: 20,
    orderBy: { updatedAt: "desc" },
  });
}
