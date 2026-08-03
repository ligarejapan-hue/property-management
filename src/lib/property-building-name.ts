/**
 * 物件名 (マンション名・アパート名) の扱いを決める純ロジック。
 *
 * 発注者要望 (2026-08-03):
 * 「物件登録時に物件種別が一棟アパート、一棟マンション、区分マンションの場合
 *   物件名を入れる部分が欲しい。ただし任意で」
 *
 * 業務上の意味: 集合住宅は住所だけでは特定しづらく、現場でも所有者との会話でも
 * 「〇〇マンション」で通る。土地や戸建には無いので、種別で出し分ける。
 *
 * このモジュールは UI から切り離した純関数のみ:
 * - fetch / storage / console を使わない
 * - **どこから登録しても同じ判定**になるよう、UI と API の両方がここを参照する
 */

import type { PropertyTypeValue } from "@/lib/property-types";

/**
 * 物件名を入力できる種別。
 *
 * ⚠**発注者が挙げた3種別ちょうど**にする。旧値 (`building`=建物（旧） /
 * `unit`=区分（旧）) は含めない。「建物（旧）」は戸建も含み得る曖昧な区分で、
 * 勝手に広げると「土地なのに物件名がある」類の不整合を招く。旧値のデータで
 * 物件名を入れたい場合は、先に種別を現行値へ直してもらう。
 */
export const PROPERTY_TYPES_WITH_BUILDING_NAME: readonly string[] = [
  "apartment_block", // 一棟アパート
  "apartment_building", // 一棟マンション
  "apartment_unit", // 区分マンション
];

/** 物件名の最大文字数。実在の建物名はこれを超えない。 */
export const BUILDING_NAME_MAX_LENGTH = 100;

/** その種別で物件名を入力できるか。 */
export function supportsBuildingName(
  propertyType: string | null | undefined,
): boolean {
  if (!propertyType) return false;
  return PROPERTY_TYPES_WITH_BUILDING_NAME.includes(propertyType);
}

/**
 * 保存する物件名を決める。
 *
 * ⚠**種別が対象外なら必ず null**。画面では種別に応じて入力欄を隠すが、それだけ
 * だと API を直接叩けば「土地」に物件名を入れられ、**画面に出ないデータが DB に
 * 残る**。見えない値は誰も直せず、CSV 出力や差込で初めて表に出て事故になる。
 * サーバー側でも同じ判定を通す。
 *
 * ⚠空白のみの入力は null にする (見た目は空なのに「入っている」状態を作らない)。
 */
export function normalizeBuildingName(
  propertyType: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (!supportsBuildingName(propertyType)) return null;
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, BUILDING_NAME_MAX_LENGTH);
}

/** 型を絞りたい呼び出し側向け (PropertyTypeValue を受ける版)。 */
export function supportsBuildingNameForType(
  propertyType: PropertyTypeValue,
): boolean {
  return supportsBuildingName(propertyType);
}
