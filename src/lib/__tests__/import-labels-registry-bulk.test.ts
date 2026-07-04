import { describe, it, expect } from "vitest";
import {
  IMPORT_TYPE_LABELS,
  getImportTypeLabel,
  IMPORT_TYPE_FILTER_OPTIONS,
} from "@/lib/import-labels";

describe("import-labels: registry_pdf_bulk", () => {
  it("registry_pdf_bulk のラベルが定義されている", () => {
    expect(IMPORT_TYPE_LABELS.registry_pdf_bulk).toBe("所有者事項PDF一括");
    expect(getImportTypeLabel("registry_pdf_bulk")).toBe("所有者事項PDF一括");
  });

  it("履歴フィルタ選択肢に registry_pdf_bulk が含まれる", () => {
    expect(
      IMPORT_TYPE_FILTER_OPTIONS.some((o) => o.value === "registry_pdf_bulk"),
    ).toBe(true);
  });
});
