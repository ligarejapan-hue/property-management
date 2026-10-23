/** 金額の3桁区切り(書類・計算式の文字列用)。 */
export function yen(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
