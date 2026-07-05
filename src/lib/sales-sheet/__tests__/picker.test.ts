import { describe, it, expect } from "vitest";
import {
  SALES_SHEET_CAPABLE_PROPERTY_TYPES,
  SALES_SHEET_REGISTRABLE_PROPERTY_TYPES,
  buildPickerListParams,
  buildPickerRows,
} from "../picker";
import { salesSheetTemplateKindFor } from "../template-kind";

describe("対象種別リスト（template-kind と同期）", () => {
  it("CAPABLE 全要素がテンプレ種別に解決できる", () => {
    for (const t of SALES_SHEET_CAPABLE_PROPERTY_TYPES) {
      expect(salesSheetTemplateKindFor(t)).not.toBeNull();
    }
  });

  it("対象外種別（store / 旧 building）を含まない", () => {
    expect(SALES_SHEET_CAPABLE_PROPERTY_TYPES).not.toContain("store");
    expect(SALES_SHEET_CAPABLE_PROPERTY_TYPES).not.toContain("building");
  });

  it("REGISTRABLE は旧値 unit を含まず全てテンプレ種別に解決できる", () => {
    expect(SALES_SHEET_REGISTRABLE_PROPERTY_TYPES).not.toContain("unit");
    for (const t of SALES_SHEET_REGISTRABLE_PROPERTY_TYPES) {
      expect(salesSheetTemplateKindFor(t)).not.toBeNull();
    }
  });
});

describe("buildPickerListParams", () => {
  it("propertyTypes join・既定 page=1 limit=50 更新日降順", () => {
    const p = buildPickerListParams({});
    expect(p.propertyTypes).toBe(
      "land,apartment_unit,unit,house,apartment_building,apartment_block",
    );
    expect(p.page).toBe("1");
    expect(p.limit).toBe("50");
    expect(p.sortBy).toBe("updatedAt");
    expect(p.sortOrder).toBe("desc");
    expect(p.keyword).toBeUndefined();
  });

  it("keyword は trim して非空のときだけ付ける", () => {
    expect(buildPickerListParams({ keyword: "  " }).keyword).toBeUndefined();
    expect(buildPickerListParams({ keyword: " 杉並 " }).keyword).toBe("杉並");
  });

  it("page を反映する", () => {
    expect(buildPickerListParams({ page: 3 }).page).toBe("3");
  });
});

describe("buildPickerRows", () => {
  it("種別ラベルとテンプレ種別を導出する（旧 unit → mansion）", () => {
    const rows = buildPickerRows([
      { id: "p1", propertyType: "land", address: "A", updatedAt: "2026-07-01T00:00:00Z" },
      { id: "p2", propertyType: "unit", address: "B", updatedAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(rows[0]).toMatchObject({ id: "p1", typeLabel: "土地", kind: "land" });
    expect(rows[1]).toMatchObject({ id: "p2", typeLabel: "区分（旧）", kind: "mansion" });
  });

  it("対象外種別は kind=null（クリック不可ガード）", () => {
    const rows = buildPickerRows([
      { id: "p3", propertyType: "store", address: "C", updatedAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(rows[0].kind).toBeNull();
  });
});
