/** 固定資産税の標準税率 1.4%(1/100 % の整数)。 */
export const FIXED_ASSET_RATE_BP = 140;
/** 都市計画税 0.3%。 */
export const CITY_PLANNING_RATE_BP = 30;

/** 精算の固都税の1行(土地または建物1つ)。課税標準額は評価証明書の値、税額は手で入れたときだけ(null=自動)。 */
export interface TaxItem {
  kind: "land" | "building";
  label: string | null;
  fixedBase: number | null;
  cityBase: number | null;
  shareNum: number;
  shareDen: number;
  fixedTax: number | null;
  cityTax: number | null;
}

/**
 * 課税標準額 → 税額(地方税法 20条の4の2)。持分を掛けてから千円未満を切り捨て、税率を掛けて百円未満を切り捨てる。
 * 浮動小数の誤差を避けるため BigInt で計算する。
 */
export function taxFromBase(base: number, shareNum: number, shareDen: number, rateBp: number): number {
  const b = (BigInt(base) * BigInt(shareNum)) / (BigInt(shareDen) * BigInt(1000)) * BigInt(1000);
  return Number((b * BigInt(rateBp)) / BigInt(10000 * 100)) * 100;
}

/** 行の税額。auto=課税標準額からの値(空なら null)、fixed/city=手で入れた値 ?? auto ?? 0。 */
export function itemTaxes(i: TaxItem) {
  const fixedAuto = i.fixedBase === null ? null : taxFromBase(i.fixedBase, i.shareNum, i.shareDen, FIXED_ASSET_RATE_BP);
  const cityAuto = i.cityBase === null ? null : taxFromBase(i.cityBase, i.shareNum, i.shareDen, CITY_PLANNING_RATE_BP);
  return { fixedAuto, cityAuto, fixed: i.fixedTax ?? fixedAuto ?? 0, city: i.cityTax ?? cityAuto ?? 0 };
}

/** 土地・建物ごとの年税額(固定資産税+都市計画税)。 */
export function annualByKind(items: TaxItem[]): { land: number; building: number } {
  const out = { land: 0, building: 0 };
  for (const i of items) {
    const t = itemTaxes(i);
    out[i.kind] += t.fixed + t.city;
  }
  return out;
}
