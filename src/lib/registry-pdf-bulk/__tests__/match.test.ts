import { describe, it, expect } from "vitest";
import { buildPropertyIndex, matchProperty, canonicalAddressKey } from "../match";

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

describe("canonicalAddressKey", () => {
  it("都道府県接頭辞を除去する", () => {
    expect(canonicalAddressKey("東京都世田谷区上馬２丁目７５２－３")).toBe(
      "世田谷区上馬2丁目752-3",
    );
  });

  it("末尾の「外N」(正規化後)を除去する", () => {
    expect(canonicalAddressKey("世田谷区上馬２丁目７５２－３外２")).toBe(
      "世田谷区上馬2丁目752-3",
    );
  });

  it("「外N」の前に空白があっても末尾空白を残さない", () => {
    expect(canonicalAddressKey("世田谷区上馬２丁目７５２－３ 外２")).toBe(
      "世田谷区上馬2丁目752-3",
    );
    expect(canonicalAddressKey("東京都世田谷区上馬２丁目７５２－３　外３")).toBe(
      "世田谷区上馬2丁目752-3",
    );
  });

  it("都道府県接頭辞+外N の両方を除去する", () => {
    expect(
      canonicalAddressKey("東京都世田谷区上馬２丁目７５２－３外２"),
    ).toBe("世田谷区上馬2丁目752-3");
  });

  it("接頭辞/接尾辞が無くてもそのまま(既存挙動を壊さない)", () => {
    expect(canonicalAddressKey("世田谷区上馬２丁目７５２－３")).toBe(
      "世田谷区上馬2丁目752-3",
    );
  });

  it("除去の結果空文字になる場合は空文字を返す", () => {
    expect(canonicalAddressKey("東京都")).toBe("");
  });

  it("null/undefined/空文字は空文字", () => {
    expect(canonicalAddressKey(null)).toBe("");
    expect(canonicalAddressKey(undefined)).toBe("");
    expect(canonicalAddressKey("")).toBe("");
  });
});

describe("buildPropertyIndex / matchProperty: 実データ形式(都道府県接頭辞/外N)", () => {
  it("index側に都道府県接頭辞が付いていても、接頭辞なしのqueryで一致する", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "東京都世田谷区上馬２丁目７５２－３", realEstateNumber: null },
    ]);
    const r = matchProperty(idx, { location: "世田谷区上馬２丁目７５２－３" });
    expect(r).toEqual({ status: "matched", propertyId: "p1", matchedBy: "address" });
  });

  it("index側に「外N」接尾辞が付いていても、接尾辞なしのqueryで一致する", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "世田谷区上馬２丁目７５２－３外２", realEstateNumber: null },
    ]);
    const r = matchProperty(idx, { location: "世田谷区上馬２丁目７５２－３" });
    expect(r).toEqual({ status: "matched", propertyId: "p1", matchedBy: "address" });
  });

  it("index側に都道府県接頭辞+外N両方付いていても、素の所在(query)で一致する", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "東京都世田谷区上馬２丁目７５２－３外２", realEstateNumber: null },
    ]);
    const r = matchProperty(idx, { location: "世田谷区上馬２丁目７５２－３" });
    expect(r).toEqual({ status: "matched", propertyId: "p1", matchedBy: "address" });
  });

  it("正準化後に空文字になる住所は index に入らず not_found", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "東京都", realEstateNumber: null },
    ]);
    expect(idx.byAddress.size).toBe(0);
    expect(matchProperty(idx, { location: "東京都" })).toEqual({ status: "not_found" });
  });

  it("正準化後に衝突する複数物件は multiple", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "東京都世田谷区等々力２丁目３４－７３", realEstateNumber: null },
      { id: "p2", address: "世田谷区等々力２丁目３４－７３外３", realEstateNumber: null },
    ]);
    const r = matchProperty(idx, { location: "世田谷区等々力２丁目３４－７３" });
    expect(r).toEqual({ status: "multiple", count: 2 });
  });

  it("realEstateNumber は全角数字でも正規化して一致する", () => {
    const idx = buildPropertyIndex([
      { id: "p1", address: "世田谷区弦巻１丁目３２－３１", realEstateNumber: "0123456789012" },
    ]);
    const r = matchProperty(idx, {
      location: "無関係の所在",
      realEstateNumber: "０１２３４５６７８９０１２", // 全角
    });
    expect(r).toEqual({
      status: "matched",
      propertyId: "p1",
      matchedBy: "real_estate_number",
    });
  });
});
