import { describe, it, expect, vi } from "vitest";
import { PROPERTY_TYPE_VALUES } from "@/lib/property-types";
import { structuredFieldsFor, STRUCTURED_FIELDS } from "../structured-fields";

// property-edit-form は画面部品(依存が重い)なので、関数だけを取り出して比べる。
vi.mock("@/lib/api-client", () => ({
  USE_MOCK: false,
  fetchUsers: vi.fn(),
  apiErrorCode: vi.fn(),
  codeFromErrorBody: vi.fn(),
}));
import { salesFieldsFor } from "@/components/properties/property-edit-form";

describe("取込が物件の欄に入れてよい項目 = 通常の物件編集で見える欄(棟なし)", () => {
  it.each([...PROPERTY_TYPE_VALUES, "unit"])("種別 %s で、編集画面(salesFieldsFor・棟なし)と一致する", (type) => {
    // ⚠取込で作る物件は棟に紐づかない(hasBuilding: false)。
    const visible = new Set(salesFieldsFor(type, { hasBuilding: false }).map((f) => f.key));
    const expected = STRUCTURED_FIELDS.filter((k) => visible.has(k));
    expect([...structuredFieldsFor(type)].sort()).toEqual([...expected].sort());
  });

  it("代表例: 土地=土地面積だけ・戸建=3つとも・区分=築年だけ・種別不明=なし", () => {
    expect([...structuredFieldsFor("land")]).toEqual(["landArea"]);
    expect([...structuredFieldsFor("house")].sort()).toEqual(["builtYear", "landArea", "totalFloorArea"]);
    expect([...structuredFieldsFor("apartment_unit")]).toEqual(["builtYear"]);
    expect([...structuredFieldsFor("unknown")]).toEqual([]);
  });
});
