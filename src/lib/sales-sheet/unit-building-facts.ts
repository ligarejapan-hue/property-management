/**
 * 区分マンションの「棟の項目」(構造・地上階・地下階・総戸数・築年月)をどこから読むか。
 *
 * - 棟に紐づいていれば**棟の値が正**(同じ棟の全部屋で共有する・従来どおり)。
 *   ただし**棟の欄が空のときだけ**、その欄は物件そのものの欄から読む(2026-11-15 発注者決定=案3)。
 *   物件名と一緒に入れた値が、棟ができた瞬間に見えなくなっていたため(すでにその状態の物件も見えるようにする)。
 *   棟に値が入っていれば、物件の欄に何が入っていても棟の値を使う。
 * - 棟に紐づいていなければ**物件そのものの欄**から読む。本番の区分マンションは全件が
 *   棟に紐づいていない(2026-09-27 実測・42,339件)ため、棟だけを見ていると
 *   この5項目は入れる場所も出す場所も無かった。物件の表には戸建・一棟と同じ列
 *   (structureType/aboveFloors/basementFloors/totalUnits/builtYear/builtMonth)がある。
 *
 * 図面の中身(build-document)・作成画面の既定値(SalesSheetCreateButton)・
 * 物件の編集画面が、同じ判断をこの1か所から使う。
 */
export type UnitBuildingFacts = {
  structureType: string | null;
  /** 地上階(棟は totalFloors・物件は aboveFloors)。 */
  totalFloors: number | null;
  basementFloors: number | null;
  totalUnits: number | null;
  builtYear: number | null;
  builtMonth: number | null;
};

type PropertyFactColumns = {
  structureType?: string | null;
  aboveFloors?: number | null;
  basementFloors?: number | null;
  totalUnits?: number | null;
  builtYear?: number | null;
  builtMonth?: number | null;
};

type BuildingFactColumns = {
  structureType?: string | null;
  totalFloors?: number | null;
  basementFloors?: number | null;
  totalUnits?: number | null;
  builtYear?: number | null;
  builtMonth?: number | null;
};

export function unitBuildingFacts(
  property: PropertyFactColumns,
  building: BuildingFactColumns | null | undefined,
): UnitBuildingFacts {
  if (building) {
    // ⚠築年月は**年と月をひと組**で扱う。棟に築年があるのに、月だけ物件の欄から持ってくると
    //   「棟の年+部屋の月」という、どこにも無い年月ができる。棟に年も月も無いときだけ、物件の年月を使う
    //   (棟に月だけ入っているときも棟の側を使う=今までどおり月だけ出る)。
    const builtFromBuilding = building.builtYear != null || building.builtMonth != null;
    return {
      structureType: building.structureType?.trim() ? building.structureType : (property.structureType ?? null),
      totalFloors: building.totalFloors ?? property.aboveFloors ?? null,
      basementFloors: building.basementFloors ?? property.basementFloors ?? null,
      totalUnits: building.totalUnits ?? property.totalUnits ?? null,
      builtYear: builtFromBuilding ? (building.builtYear ?? null) : (property.builtYear ?? null),
      builtMonth: builtFromBuilding ? (building.builtMonth ?? null) : (property.builtMonth ?? null),
    };
  }
  return {
    structureType: property.structureType ?? null,
    totalFloors: property.aboveFloors ?? null,
    basementFloors: property.basementFloors ?? null,
    totalUnits: property.totalUnits ?? null,
    builtYear: property.builtYear ?? null,
    builtMonth: property.builtMonth ?? null,
  };
}
