/**
 * 取込(貼り付け・Excel の顧客管理表)でお客様が書いた面積の扱い。
 *
 * - 2026-10-24 発注者決定: 区分マンションの専有面積は「登記簿(内法)」と「壁芯(パンフレット)」で
 *   ほぼ必ず数％ずれる。お客様の書いた数字はどちらか分からないので、どちらの欄にも入れない。
 * - 2026-10-26 発注者決定: **面積はすべて**(土地面積・建物面積・延床面積も)欄に入れず備考へ。
 *   査定の申込に書かれた面積は実際の面積と違うことが多々あるため。欄は謄本や手入力で埋める。
 * ⚠ Prisma / next を import しない(画面と API の両方から読む)。
 */

/** 備考に残すときの見出し(区分マンションの専有面積)。 */
export const CUSTOMER_AREA_NOTE_LABEL = "専有面積（お客様の記載・登記簿か壁芯か不明）";
/** 区分以外で「専有面積」の欄に読んだ値(建物面積)。 */
export const CUSTOMER_BUILDING_AREA_NOTE_LABEL = "建物面積（お客様の記載）";
export const CUSTOMER_LAND_AREA_NOTE_LABEL = "土地面積（お客様の記載）";
export const CUSTOMER_TOTAL_FLOOR_AREA_NOTE_LABEL = "延床面積（お客様の記載）";

/** 確認画面の欄の下に出す案内。 */
export const CUSTOMER_AREA_HINT = "※お客様の記載のため、面積の欄には入れず備考に記録されます";

/** 取込で受け取った面積(検査済みの数字の文字列・空は null)を、物件の備考の行にする。 */
export function customerAreaNoteLines(input: {
  isUnit: boolean;
  exclusiveArea: string | null;
  landArea: string | null;
  totalFloorArea: string | null;
}): string[] {
  const lines: string[] = [];
  if (input.exclusiveArea !== null) {
    const label = input.isUnit ? CUSTOMER_AREA_NOTE_LABEL : CUSTOMER_BUILDING_AREA_NOTE_LABEL;
    lines.push(`${label}: ${input.exclusiveArea}㎡`);
  }
  if (input.landArea !== null) lines.push(`${CUSTOMER_LAND_AREA_NOTE_LABEL}: ${input.landArea}㎡`);
  if (input.totalFloorArea !== null) {
    lines.push(`${CUSTOMER_TOTAL_FLOOR_AREA_NOTE_LABEL}: ${input.totalFloorArea}㎡`);
  }
  return lines;
}
