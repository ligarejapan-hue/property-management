import { describe, expect, it } from "vitest";
import { saleYenHistoryValue } from "../property-change-labels";

describe("saleYenHistoryValue(価格の履歴を円で出す)", () => {
  it("価格・うち消費税の万円の値を円の書き方に", () => {
    expect(saleYenHistoryValue("salePrice", "3280")).toBe("3,280万円");
    expect(saleYenHistoryValue("salePrice", "3280.15")).toBe("3,280万1,500円");
    expect(saleYenHistoryValue("saleTaxAmount", "300.0001")).toBe("300万1円");
  });
  it("ほかの欄・空・読めない値は null(呼び出し側が今までどおり出す)", () => {
    expect(saleYenHistoryValue("managementFee", "18800")).toBeNull();
    expect(saleYenHistoryValue("salePrice", null)).toBeNull();
    expect(saleYenHistoryValue("salePrice", "")).toBeNull();
    expect(saleYenHistoryValue("salePrice", "応談")).toBeNull();
  });
});
