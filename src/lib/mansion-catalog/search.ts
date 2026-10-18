/** 「マンション棟」の検索の2段目=名簿にあるマンションの1行(設計 2026-10-18 §6.3)。React に依存しない。 */
export interface CatalogSearchItem {
  id: string; name: string; address: string;
  builtYear: number | null; builtMonth: number | null; totalFloors: number | null; totalUnits: number | null;
  managementCompany: string | null;
}

export function catalogSearchLine(i: CatalogSearchItem): string {
  return [
    i.builtYear !== null ? `${i.builtYear}年${i.builtMonth !== null ? `${i.builtMonth}月` : ""}竣工` : null,
    i.totalFloors !== null ? `${i.totalFloors}階建` : null,
    i.totalUnits !== null ? `${i.totalUnits}戸` : null,
    i.managementCompany ? `管理: ${i.managementCompany}` : null,
  ].filter(Boolean).join("・");
}
