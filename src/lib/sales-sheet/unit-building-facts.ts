/**
 * 区分マンションの「棟の項目」(構造・地上階・地下階・総戸数・築年月)をどこから読むか。
 *
 * - 棟に紐づいていれば**棟の値が正**(同じ棟の全部屋で共有する・従来どおり)。
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
    return {
      structureType: building.structureType ?? null,
      totalFloors: building.totalFloors ?? null,
      basementFloors: building.basementFloors ?? null,
      totalUnits: building.totalUnits ?? null,
      builtYear: building.builtYear ?? null,
      builtMonth: building.builtMonth ?? null,
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
