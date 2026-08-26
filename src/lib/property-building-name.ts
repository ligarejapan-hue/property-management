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

/**
 * 物件名の最大文字数。実在の建物名はこれを超えない。
 *
 * ⚠**超えたら切り詰めずに断る** (@codex #354 P2)。以前はこの関数で
 * `slice` していたが、入力とバリデーションで扱いが食い違っていた:
 *   - 保存側は「切り詰める」
 *   - 入力検証は「生の文字数で弾く」
 * その結果、**99文字の名前の前後に空白が付いただけで 422** になり、しかも
 * 切り詰めの動きには一度も到達しなかった。黙って名前を切るのは利用者から
 * 見て事故なので、**整えてから測り、超えていればエラーで返す**に統一する。
 * 入力欄側にも同じ上限 (maxLength) を付けて、そもそも超えて入らないようにする。
 */
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
 * ⚠**長すぎる入力をここで切り詰めない**。長さは入力検証 (zod) が
 * 「整えてから測って超えていれば断る」で見る。ここで黙って切ると、利用者は
 * 名前が削られたことに気づけない。
 */
export function normalizeBuildingName(
  propertyType: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (!supportsBuildingName(propertyType)) return null;
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/** 型を絞りたい呼び出し側向け (PropertyTypeValue を受ける版)。 */
export function supportsBuildingNameForType(
  propertyType: PropertyTypeValue,
): boolean {
  return supportsBuildingName(propertyType);
}

/**
 * 入力中の値が長すぎるか (画面に出す注意書き用)。
 *
 * ⚠**数える前に整える** (@codex #354 P2)。入力欄の `maxLength` は**生の文字数**で
 * 打ち切るため、前後に空白のある 100 文字ちょうどの名前を貼り付けると、
 * ブラウザが**黙って実文字を削る**。切り詰めを禁じておきながら入力側で切るのは
 * 矛盾なので、`maxLength` は使わず「超えていることを画面で伝えて保存を止める」。
 */
export function isBuildingNameTooLong(
  value: string | null | undefined,
): boolean {
  return (value ?? "").trim().length > BUILDING_NAME_MAX_LENGTH;
}

/** 長すぎるときに画面へ出す文言 (入力側・保存側で同じ言い回しにする)。 */
export const BUILDING_NAME_TOO_LONG_MESSAGE = `物件名は${BUILDING_NAME_MAX_LENGTH}文字以内で入力してください（前後の空白は数えません）`;

// ---------------------------------------------------------------------------
// 区分マンション専用の欄（@codex PR#414 10巡目）
//
// ⚠**物件名(buildingName)だけを種別で正規化して、隣の同種の欄を素通しにしていた**。
// 物件詳細 (src/app/(dashboard)/properties/[id]/page.tsx の `isUnit` ブロック) は
// これらの欄を**区分マンションのときしか描かない**。しかも
// `updatePropertySchema` にも `createPropertySchema` にも無いので、
// **通常の編集画面からは直せない**。種別に合わないまま保存すると
// 「見えず、直せないデータ」が残り、CSV 出力や DM 差込で初めて表に出る。
//
// ⚠個別に潰さず**1か所で判定する**。次に区分専用の欄が増えたときも、
// この配列へ足せば保存経路が自動的に守られる
// (__tests__ の走査テストが、保存経路の欄がこの関数を通っているかを固定する)。
// ---------------------------------------------------------------------------

/** 区分専用の欄を持てる種別（旧値 `unit` も区分として扱う）。 */
export const PROPERTY_TYPES_WITH_UNIT_FIELDS: readonly string[] = [
  "apartment_unit", // 区分マンション
  "unit", // 区分（旧）
];

/**
 * 区分マンションのときだけ意味を持つ欄の名前。
 * 物件詳細の `isUnit` ブロックが描いている欄と**同じ集合**にすること。
 */
export const UNIT_ONLY_PROPERTY_FIELDS = [
  "roomNo",
  "floorNo",
  "exclusiveArea",
  "balconyArea",
  "layoutType",
  "orientation",
  "managementFee",
  "repairReserveFee",
  "occupancyStatus",
  "ownershipShareNote",
] as const;

export type UnitOnlyPropertyField = (typeof UNIT_ONLY_PROPERTY_FIELDS)[number];

const UNIT_ONLY_FIELD_SET: ReadonlySet<string> = new Set(UNIT_ONLY_PROPERTY_FIELDS);

/** その種別が区分専用の欄を持てるか。 */
export function supportsUnitFields(
  propertyType: string | null | undefined,
): boolean {
  if (!propertyType) return false;
  return PROPERTY_TYPES_WITH_UNIT_FIELDS.includes(propertyType);
}

/**
 * 種別に合わない区分専用の欄を **null に落とす**（`normalizeBuildingName` と同じ姿勢）。
 *
 * 渡された値のうち `UNIT_ONLY_PROPERTY_FIELDS` に載っている欄だけを対象にする。
 * それ以外の欄はそのまま通す（呼び出し側が誤って混ぜても壊さない）。
 */
export function normalizeUnitOnlyFields<T extends Record<string, unknown>>(
  propertyType: string | null | undefined,
  values: T,
): { [K in keyof T]: T[K] | null } {
  if (supportsUnitFields(propertyType)) {
    return { ...values } as { [K in keyof T]: T[K] | null };
  }
  const out: Record<string, unknown> = { ...values };
  for (const key of Object.keys(out)) {
    if (UNIT_ONLY_FIELD_SET.has(key)) out[key] = null;
  }
  return out as { [K in keyof T]: T[K] | null };
}
