/**
 * 取込(Excel まとめ取込)が物件の**正式な欄**に入れてよい項目を、種別ごとに決める。純関数。
 *
 * ⚠規則は**通常の物件編集画面の「販売」区分で見える欄**と同じにする
 *   (src/components/properties/property-edit-form.tsx の salesFieldsFor・棟なし)。
 *   見えない欄に値を入れると、誰も見られず直せないデータが残る(@codex PR#456 4巡目)。
 *   向こうは画面部品(サーバーから読めない)なので、ここに同じ規則を置き、
 *   一致をテスト(__tests__/structured-fields.test.ts)で固定している。
 * ⚠取込で作る物件は棟に紐づかない。区分マンションの築年は、棟なしの区分では
 *   物件の欄として編集画面に出る。
 */
export const STRUCTURED_FIELDS = ["landArea", "totalFloorArea", "builtYear"] as const;
export type StructuredField = (typeof STRUCTURED_FIELDS)[number];

const ALL: ReadonlySet<StructuredField> = new Set(STRUCTURED_FIELDS);
const LAND_ONLY: ReadonlySet<StructuredField> = new Set(["landArea"]);
const YEAR_ONLY: ReadonlySet<StructuredField> = new Set(["builtYear"]);
const NONE: ReadonlySet<StructuredField> = new Set();

export function structuredFieldsFor(propertyType: string | null | undefined): ReadonlySet<StructuredField> {
  switch (propertyType) {
    case "land":
      return LAND_ONLY;
    case "house":
    case "apartment_building":
    case "apartment_block":
      return ALL;
    case "apartment_unit":
    case "unit":
      return YEAR_ONLY;
    default:
      return NONE;
  }
}
