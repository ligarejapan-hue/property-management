/**
 * 新しい棟を作るとき、部屋(区分マンションの物件)に入っている「棟の項目」を棟へ写す(2026-11-15 発注者決定=案3)。
 *
 * ⚠なぜ要るか: 棟につながっていない区分の編集で、物件名と一緒に 構造・地上階・地下階・総戸数・築年月 を
 *   入れて保存すると、その保存で新しい棟が作られてつながる。棟ができたあとは、詳細・編集・販売図面が
 *   棟の値を見るので、部屋に入れた値が見えなくなっていた(実機確認 2026-11-15)。
 * ⚠写すのは**棟を新しく作る瞬間だけ**。すでにある棟へつなぐときは棟の値が正なので触らない。
 * ⚠マンション名簿に当たったときは名簿の値を優先する(呼び出し側が、この値の上に名簿の値を重ねる)。
 * ⚠部屋の側の値は消さない(棟から外したときに戻る・変更履歴と食い違わせない)。
 */

/** 部屋から読む列(物件の表)。 */
export const UNIT_FACT_SELECT = {
  structureType: true,
  aboveFloors: true,
  basementFloors: true,
  totalUnits: true,
  builtYear: true,
  builtMonth: true,
} as const;

export type UnitFactRow = {
  structureType?: string | null;
  aboveFloors?: number | null;
  basementFloors?: number | null;
  totalUnits?: number | null;
  builtYear?: number | null;
  builtMonth?: number | null;
};

/** 棟へ入れる値(棟の列の名前で・入っている欄だけ)。地上階は 物件=aboveFloors → 棟=totalFloors。 */
export type NewBuildingFacts = {
  structureType?: string;
  totalFloors?: number;
  basementFloors?: number;
  totalUnits?: number;
  builtYear?: number;
  builtMonth?: number;
};

export function newBuildingFactsFromUnit(unit: UnitFactRow | null | undefined): NewBuildingFacts {
  if (!unit) return {};
  const out: NewBuildingFacts = {};
  const structure = unit.structureType?.trim();
  if (structure) out.structureType = structure;
  if (unit.aboveFloors != null) out.totalFloors = unit.aboveFloors;
  if (unit.basementFloors != null) out.basementFloors = unit.basementFloors;
  if (unit.totalUnits != null) out.totalUnits = unit.totalUnits;
  if (unit.builtYear != null) out.builtYear = unit.builtYear;
  if (unit.builtMonth != null) out.builtMonth = unit.builtMonth;
  return out;
}
