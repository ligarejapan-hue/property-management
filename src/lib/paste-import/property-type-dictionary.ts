/**
 * 物件種別の言い換え → PropertyType。
 * ⚠知らない種別は unknown + confident=false にして、確認画面で人に決めてもらう。
 *   推測で決めると、間違った種別のまま登録される。
 *
 * ⚠**対応先の値は `src/lib/property-types.ts` の表示ラベルと意味が一致すること**。
 *   実例(全体レビュー I-4): 「一棟アパート」を apartment_building に寄せていたが、
 *   apartment_building の表示ラベルは**「一棟マンション」**であり
 *   (「一棟アパート」は apartment_block)、確認画面は緑=「読み取れました」の
 *   見た目のまま**種別が黙って化ける**状態だった。
 *   __tests__/property-type-dictionary.test.ts が、下の全ルールについて
 *   「言い換え語の意味」と「対応先の表示ラベル」の一致を機械的に固定している。
 */
export type MappedPropertyType =
  | "land" | "house" | "apartment_unit" | "apartment_building" | "apartment_block"
  | "store" | "office" | "unknown";

export interface PropertyTypeRule {
  needle: string;
  value: MappedPropertyType;
}

/**
 * 部分一致で判定する。**順序が意味を持つ**。
 *
 * ⚠規律: **より限定的な語（別の語を丸ごと含む語）を、広い語より必ず先に置く**。
 *   - 「一棟マンション」が「マンション」より前にないと apartment_unit になる
 *   - 「住宅用地」が「住宅」より前にないと house になる（＝土地が戸建に化ける）
 *   同じ形の取り違えが2回起きたので、**順序そのものをテストで固定**した
 *   (__tests__/property-type-dictionary.test.ts。後ろの語を前の語が含んでいたら
 *   名指しで落ちる)。語を足す人が順序を間違えたら気づける。
 */
export const PROPERTY_TYPE_RULES: readonly PropertyTypeRule[] = [
  // 「◯◯用地」は**土地**。広い語(住宅 / マンション)より必ず前に置く。
  { needle: "マンション用地", value: "land" },
  { needle: "住宅用地", value: "land" },
  { needle: "一棟マンション", value: "apartment_building" },
  { needle: "一棟アパート", value: "apartment_block" },
  { needle: "区分所有", value: "apartment_unit" },
  { needle: "分譲マンション", value: "apartment_unit" },
  { needle: "マンション", value: "apartment_unit" },
  { needle: "一戸建", value: "house" },
  { needle: "戸建", value: "house" },
  { needle: "一般住宅", value: "house" },
  { needle: "住宅", value: "house" },
  { needle: "土地", value: "land" },
  { needle: "更地", value: "land" },
  { needle: "店舗", value: "store" },
  { needle: "事務所", value: "office" },
];

export function propertyTypeForRaw(raw: string): {
  value: MappedPropertyType;
  confident: boolean;
} {
  const s = raw.replace(/[\s　]/g, "");
  if (s === "") return { value: "unknown", confident: false };
  for (const rule of PROPERTY_TYPE_RULES) {
    if (s.includes(rule.needle)) return { value: rule.value, confident: true };
  }
  return { value: "unknown", confident: false };
}
