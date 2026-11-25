/**
 * 物件の編集画面の欄を、物件の詳細「基本情報」と同じ順に並べる(2026-11-25 発注者「基本情報順に編集できるように」)。純関数。
 *
 * 基本情報に出ている欄(販売用の欄に入っている専有面積・管理費・土地面積・現況なども)を「基本」区分へ寄せ、
 * 基本情報の表示と同じ順にする。基本情報に出ていない欄(価格・消費税・交通・駐車場・利回り・調査の欄など)は
 * 今までどおりの区分・順のまま、その後ろに置く。
 * ⚠欄を足す・消すことはしない(並びと区分だけ)=保存・控え・検証は今までどおり。
 * ⚠順は src/app/(dashboard)/properties/[id]/page.tsx の基本情報(PropertyBasicInfo)の並びに合わせる。
 *   郵便番号・緯度経度は基本情報では1行(郵便番号は住所の前・GPS座標)なのでその位置に。
 */

const isUnitType = (t: string) => t === "apartment_unit" || t === "unit";

/** 区分マンション: 部屋の欄 → 棟の項目(棟につながっていないときだけ編集できる欄)。 */
const UNIT_ORDER = [
  "roomNo", "floorNo", "exclusiveArea", "exclusiveAreaRegistry", "balconyArea", "layoutType", "orientation",
  "managementFee", "repairReserveFee", "occupancyStatus", "ownershipShareNote",
  "structureType", "aboveFloors", "basementFloors", "totalUnits", "builtYear", "builtMonth",
];

/** 区分マンション以外: 土地面積・建物面積 → 土地の現況。 */
const OTHER_ORDER = ["landArea", "landAreaMethod", "totalFloorArea", "occupancyStatus"];

const HEAD = [
  "propertyType", "businessType", "postalCode", "address", "buildingName",
  "lotNumber", "buildingNumber", "extraParcels", "realEstateNumber",
];
const TAIL = ["registryStatus", "dmStatus", "inquirerName", "assignedTo", "gpsLat", "gpsLng", "note"];

export function basicInfoOrder(propertyType: string): string[] {
  return [...HEAD, ...(isUnitType(propertyType) ? UNIT_ORDER : ["roomNo", ...OTHER_ORDER]), ...TAIL];
}

export const BASIC_SECTION = "基本";

/**
 * 欄を基本情報の順に並べ直す。基本情報に出る欄は section を「基本」にして先頭へ、残りは元の並びのまま後ろへ。
 * 同じ key が2回あっても1回だけにする(元の一覧が重ならない前提だが、念のため)。
 */
export function orderFieldsLikeBasicInfo<F extends { key: string; section: string }>(
  fields: readonly F[],
  propertyType: string,
): F[] {
  const order = basicInfoOrder(propertyType);
  const rank = new Map(order.map((k, i) => [k, i]));
  const seen = new Set<string>();
  const basic: F[] = [];
  const rest: F[] = [];
  for (const f of fields) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    if (rank.has(f.key)) basic.push(f.section === BASIC_SECTION ? f : { ...f, section: BASIC_SECTION });
    else rest.push(f);
  }
  basic.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...basic, ...rest];
}
