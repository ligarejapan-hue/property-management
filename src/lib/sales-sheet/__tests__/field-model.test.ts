import { describe, it, expect } from "vitest";
import { MANSION_FIELDS, type SheetField } from "../field-model";
import { USE_DISTRICT, TAX } from "../option-master";

const byKey = (k: string): SheetField | undefined => MANSION_FIELDS.find((f) => f.key === k);

describe("MANSION_FIELDS", () => {
  it("価格は number・万円固定", () => {
    const price = byKey("price");
    expect(price?.widget).toBe("number");
    expect(price?.unit).toBe("万円");
  });
  it("用途地域は multiselect・選択肢マスタ・自動反映元zoningDistrict", () => {
    const y = byKey("useDistrict");
    expect(y?.widget).toBe("multiselect");
    expect(y?.options).toEqual(USE_DISTRICT);
    expect(y?.autoFrom).toBe("zoningDistrict");
  });
  it("消費税はselect(課税/不課税)・controlOnly(表の行にしない)", () => {
    const t = byKey("tax");
    expect(t?.widget).toBe("select");
    expect(t?.options).toEqual(TAX);
    expect(t?.controlOnly).toBe(true);
  });
  it("うち消費税は税=課税のときだけ表示", () => {
    const s = byKey("taxAmount");
    expect(s?.showWhen).toEqual({ field: "tax", equals: "課税" });
    expect(s?.unit).toBe("万円");
  });
  it("複数選択はマンションでは用途地域のみ(地目/接道/地域地区/都市計画はF2で追加)", () => {
    for (const k of ["useDistrict"]) {
      expect(byKey(k)?.widget, k).toBe("multiselect");
    }
  });
});
