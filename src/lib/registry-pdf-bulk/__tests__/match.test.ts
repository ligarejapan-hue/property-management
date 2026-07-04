import { describe, it, expect } from "vitest";
import { buildPropertyIndex, matchProperty } from "../match";

const PROPS = [
  { id: "p1", address: "世田谷区上馬２丁目７５２－３", realEstateNumber: null },
  { id: "p2", address: "世田谷区弦巻１丁目３２－３１", realEstateNumber: "0123456789012" },
  // p3/p4 は同一所在(重複物件)
  { id: "p3", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
  { id: "p4", address: "世田谷区等々力２丁目３４－７３", realEstateNumber: null },
];

describe("buildPropertyIndex / matchProperty", () => {
  const index = buildPropertyIndex(PROPS);

  it("所在の正規化完全一致で1件に決まる(全角/半角・ハイフン揺れを吸収)", () => {
    // 半角数字+ASCIIハイフンでも NFKC+ハイフン統一で一致する
    const r = matchProperty(index, { location: "世田谷区上馬2丁目752-3" });
    expect(r).toEqual({ status: "matched", propertyId: "p1", matchedBy: "address" });
  });

  it("realEstateNumber があれば所在より優先して一致する", () => {
    const r = matchProperty(index, {
      location: "世田谷区上馬２丁目７５２－３", // p1の所在
      realEstateNumber: "0123456789012",        // p2の番号
    });
    expect(r).toEqual({
      status: "matched",
      propertyId: "p2",
      matchedBy: "real_estate_number",
    });
  });

  it("同一所在が複数あれば multiple", () => {
    const r = matchProperty(index, { location: "世田谷区等々力２丁目３４－７３" });
    expect(r).toEqual({ status: "multiple", count: 2 });
  });

  it("一致なしは not_found", () => {
    expect(matchProperty(index, { location: "杉並区高円寺南１丁目１－１" })).toEqual({
      status: "not_found",
    });
    expect(matchProperty(index, {})).toEqual({ status: "not_found" });
    expect(matchProperty(index, { location: "" })).toEqual({ status: "not_found" });
  });

  it("address が空の物件は index に入らない", () => {
    const idx = buildPropertyIndex([
      { id: "px", address: "", realEstateNumber: null },
    ]);
    expect(idx.byAddress.size).toBe(0);
  });
});
