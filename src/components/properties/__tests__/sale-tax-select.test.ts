import { describe, expect, it } from "vitest";
import { salesFieldsFor, selectOptionsWithCurrent } from "../property-edit-form";

describe("物件の編集の販売欄(2026-11-03)", () => {
  it("消費税は課税・不課税から選ぶ。価格とうち消費税は円で入れる", () => {
    for (const type of ["apartment_unit", "house", "apartment_building"]) {
      const fields = salesFieldsFor(type);
      const tax = fields.find((f) => f.key === "saleTaxType");
      expect(tax?.type).toBe("select");
      expect(tax?.options?.map((o) => o.value)).toEqual(["", "課税", "不課税"]);
      expect(fields.find((f) => f.key === "salePrice")?.label).toBe("価格(円)");
      expect(fields.find((f) => f.key === "saleTaxAmount")?.label).toBe("うち消費税(円)");
    }
  });

  it("選択肢に無い今の値は、消えないよう末尾に足して出す", () => {
    const opts = [{ value: "", label: "(未設定)" }, { value: "課税", label: "課税" }];
    expect(selectOptionsWithCurrent(opts, "税込").at(-1)).toEqual({ value: "税込", label: "税込(今の値)" });
    expect(selectOptionsWithCurrent(opts, "課税")).toBe(opts);
    expect(selectOptionsWithCurrent(opts, "")).toBe(opts);
    expect(selectOptionsWithCurrent(opts, undefined)).toBe(opts);
  });
});
