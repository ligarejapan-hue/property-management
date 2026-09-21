import { describe, it, expect } from "vitest";
import { salesFieldsFor, allSalesFields } from "../property-edit-form";

describe("salesFieldsFor — 種別ごとに出す欄", () => {
  it("土地", () => {
    expect(salesFieldsFor("land").map((f) => f.key)).toEqual([
      "salePrice", "access", "landArea", "landAreaMethod",
    ]);
  });
  it("戸建", () => {
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("totalFloorArea");
    expect(salesFieldsFor("house").map((f) => f.key)).toContain("builtYear");
    expect(salesFieldsFor("house").map((f) => f.key)).not.toContain("grossYield");
  });
  it("一棟は収益の欄も出す", () => {
    const keys = salesFieldsFor("apartment_building").map((f) => f.key);
    expect(keys).toContain("grossYield");
    expect(keys).toContain("expectedIncome");
    expect(keys).toContain("totalUnits");
  });
  it("区分は部屋の欄を出し、棟の欄は出さない", () => {
    const keys = salesFieldsFor("apartment_unit").map((f) => f.key);
    expect(keys).toContain("exclusiveArea");
    expect(keys).toContain("managementFee");
    expect(keys).not.toContain("structureType");
    expect(keys).not.toContain("totalUnits");
  });
});

// [@codex P2] 保存は「開いた時点の値(property)との差分」を送る。初期値を開いた時点の種別
// だけで読み込むと、編集中に種別を変えて現れた欄が空のまま扱われ、値が入っている物件では
// 「空へ変えた」と解釈されて**触っていない値が消える**。初期値は全種別ぶん読む＝
// allSalesFields がどの種別の欄も漏れなく含むことがその前提。
describe("allSalesFields — 初期値の読み込み範囲(@codex P2)", () => {
  const TYPES = [
    "land", "house", "apartment_building", "apartment_block", "apartment_unit", "unit",
  ];

  it("どの種別の欄も漏れなく含む", () => {
    const loaded = new Set(allSalesFields().map((f) => f.key));
    for (const t of TYPES) {
      const missing = salesFieldsFor(t).map((f) => f.key).filter((k) => !loaded.has(k));
      expect({ type: t, missing }).toEqual({ type: t, missing: [] });
    }
  });

  it("同じ欄を重複して持たない", () => {
    const keys = allSalesFields().map((f) => f.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("種別をまたいでしか現れない欄も入っている(土地だけで開いても区分の欄を読む)", () => {
    const keys = allSalesFields().map((f) => f.key);
    expect(keys).toContain("exclusiveArea"); // 区分だけの欄
    expect(keys).toContain("grossYield"); // 一棟だけの欄
    expect(keys).toContain("landArea"); // 土地・戸建・一棟の欄
  });
});
