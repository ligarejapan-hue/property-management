/**
 * 物件の詳細「基本情報」に出す**土地面積・建物面積**の行(従業員の指摘⑧ 2026-10-25)。純関数。
 *
 * 値は前から販売用の欄(landArea / landAreaMethod / totalFloorArea)に入っていたが、
 * 編集画面の「販売」区分でしか見られず、戸建・土地の基本情報に出ていなかった。
 * ⚠どの種別にどの欄を出すかは**編集画面の「販売」区分と同じ規則**(structuredFieldsFor
 *   = property-edit-form.tsx の salesFieldsFor と一致をテストで固定済み)。
 *   区分マンションは専有面積を別に出しているので、ここでは出さない。
 * ⚠規則で決まらない種別(不明・その他)は、値が入っているときだけ出す(入っている値を隠さない)。
 */
import { structuredFieldsFor } from "@/lib/paste-import/structured-fields";

export interface AreaDisplayRow {
  label: string;
  /** null = 未入力(画面は「—」)。 */
  value: string | null;
}

type Num = number | string | null | undefined;

function sqm(v: Num): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(2)}m²` : null;
}

export function landBuildingAreaRows(p: {
  propertyType: string;
  landArea: Num;
  landAreaMethod: string | null | undefined;
  totalFloorArea: Num;
}): AreaDisplayRow[] {
  const isUnit = p.propertyType === "apartment_unit" || p.propertyType === "unit";
  if (isUnit) return [];
  const allowed = structuredFieldsFor(p.propertyType);
  const known = allowed.size > 0;
  const land = sqm(p.landArea);
  const method = p.landAreaMethod?.trim() || null;
  const floor = sqm(p.totalFloorArea);
  const rows: AreaDisplayRow[] = [];
  if (known ? allowed.has("landArea") : land !== null) {
    rows.push({ label: "土地面積", value: land && method ? `${land}（${method}）` : land });
  }
  if (known ? allowed.has("totalFloorArea") : floor !== null) {
    rows.push({ label: "建物面積（延べ）", value: floor });
  }
  return rows;
}
