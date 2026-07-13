import { describe, it, expect } from "vitest";
import { createPropertySchema, updatePropertySchema } from "@/lib/validators";

// A2 (UI総点検): 物件フォームに入力チェックが無く、郵便番号"abc-de!"・不動産番号"あいうえお!!"・緯度999 が保存できた。
const base = { propertyType: "land", address: "東京都〇〇区1-2-3" };

describe("createPropertySchema: 物件の入力バリデーション(A2)", () => {
  it("正常値・空・未指定は通る(任意項目・既存編集を壊さない)", () => {
    expect(() => createPropertySchema.parse(base)).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "1000001", realEstateNumber: "1234567890123", gpsLat: 35.68, gpsLng: 139.76 })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "100-0001" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "", realEstateNumber: "" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: null, gpsLat: null })).not.toThrow();
  });

  it("不正な郵便番号を弾く", () => {
    expect(() => createPropertySchema.parse({ ...base, postalCode: "abc-de!" })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "123" })).toThrow();
  });

  it("数字以外の不動産番号を弾く", () => {
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "あいうえお!!" })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "12345678901234" })).toThrow(); // 14桁は超過
  });

  it("範囲外の緯度・経度を弾く", () => {
    expect(() => createPropertySchema.parse({ ...base, gpsLat: 999 })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, gpsLat: -91 })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, gpsLng: 999 })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, gpsLng: -181 })).toThrow();
  });
});

describe("updatePropertySchema: 同じ入力バリデーション(A2)", () => {
  // version は楽観ロックの必須項目。ここでは入力検証を切り分けるため常に付与する。
  it("正常値は通る", () => {
    expect(() => updatePropertySchema.parse({ version: 1, postalCode: "1000001", gpsLat: 35.68 })).not.toThrow();
  });
  it("不正値を弾く", () => {
    expect(() => updatePropertySchema.parse({ version: 1, postalCode: "abc-de!" })).toThrow();
    expect(() => updatePropertySchema.parse({ version: 1, realEstateNumber: "あ!" })).toThrow();
    expect(() => updatePropertySchema.parse({ version: 1, gpsLat: 999 })).toThrow();
  });
});
