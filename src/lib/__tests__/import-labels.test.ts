import { describe, it, expect } from "vitest";
import {
  IMPORT_TYPE_LABELS,
  IMPORT_TYPE_FILTER_OPTIONS,
  getImportTypeLabel,
} from "../import-labels";

describe("getImportTypeLabel", () => {
  it("既知の内部値は日本語ラベルを返す", () => {
    // property_csv は受付帳取込なので「受付帳CSV」表示
    expect(getImportTypeLabel("property_csv")).toBe("受付帳CSV");
    expect(getImportTypeLabel("owner_csv")).toBe("所有者CSV");
    expect(getImportTypeLabel("property_pdf")).toBe("謄本PDF");
    expect(getImportTypeLabel("registry_pdf")).toBe("謄本PDF");
    expect(getImportTypeLabel("dm_history_csv")).toBe("DM履歴CSV");
    expect(getImportTypeLabel("investigation_csv")).toBe("調査CSV");
  });

  it("未知の値はそのまま返す（フォールバック）", () => {
    expect(getImportTypeLabel("future_csv")).toBe("future_csv");
  });

  it("null / undefined / 空文字列は '-' を返す", () => {
    expect(getImportTypeLabel(null)).toBe("-");
    expect(getImportTypeLabel(undefined)).toBe("-");
    expect(getImportTypeLabel("")).toBe("-");
  });

  it("registry_pdf と property_pdf は同じラベル(謄本PDF)に正規化される", () => {
    expect(IMPORT_TYPE_LABELS.registry_pdf).toBe(IMPORT_TYPE_LABELS.property_pdf);
  });
});

describe("IMPORT_TYPE_FILTER_OPTIONS", () => {
  it("先頭は 'すべての種別' (value=空)", () => {
    expect(IMPORT_TYPE_FILTER_OPTIONS[0]).toEqual({ value: "", label: "すべての種別" });
  });

  it("各オプションの value は内部値、label は日本語（property_csv は受付帳CSV）", () => {
    const property = IMPORT_TYPE_FILTER_OPTIONS.find((o) => o.value === "property_csv");
    expect(property?.label).toBe("受付帳CSV");
    const owner = IMPORT_TYPE_FILTER_OPTIONS.find((o) => o.value === "owner_csv");
    expect(owner?.label).toBe("所有者CSV");
  });
});
