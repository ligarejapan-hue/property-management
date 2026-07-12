/** 1坪 = 400/121 ㎡（計量法・約3.305785㎡）。 */
export const SQM_PER_TSUBO = 400 / 121;

/** "3,480" / "150.5㎡" 等の数値文字列を number へ。非数字（カンマ/㎡/空白）除去。無効/空は null。 */
export function parseNumeric(s?: string | null): number | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 坪単価(万円/坪)=価格(万円)÷(土地面積㎡÷SQM_PER_TSUBO)。小数第1位の文字列。算出不可は ""。 */
export function computeTsuboUnitPrice(priceManYen?: string | null, landAreaSqm?: string | null): string {
  const price = parseNumeric(priceManYen);
  const area = parseNumeric(landAreaSqm);
  if (price === null || area === null || area <= 0) return "";
  const unit = price / (area / SQM_PER_TSUBO);
  if (!Number.isFinite(unit)) return "";
  return (Math.round(unit * 10) / 10).toFixed(1);
}
