import { describe, it, expect } from "vitest";
import { createPropertySchema, updatePropertySchema } from "@/lib/validators";

// A2 (UI総点検): 物件フォームに入力チェックが無く、郵便番号"abc-de!"・不動産番号"あいうえお!!"・緯度999 が保存できた。
const base = { propertyType: "land", address: "東京都〇〇区1-2-3" };

describe("createPropertySchema: 物件の入力バリデーション(A2)", () => {
  it("正常値・空・未指定は通る(任意項目・既存編集を壊さない)", () => {
    expect(() => createPropertySchema.parse(base)).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "1000001", gpsLat: 35.68, gpsLng: 139.76 })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "100-0001" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "", realEstateNumber: "" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: null, gpsLat: null })).not.toThrow();
  });

  it("全角・スペース入りの郵便番号/不動産番号は正規化して通す(import・住所補完と一貫・@codex R1)", () => {
    expect(() => createPropertySchema.parse({ ...base, postalCode: "１００−０００１" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "100 0001" })).not.toThrow();
  });

  it("不正な郵便番号を弾く", () => {
    expect(() => createPropertySchema.parse({ ...base, postalCode: "abc-de!" })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, postalCode: "123" })).toThrow();
  });

  it("⚠不動産番号は**どんな値でも**弾く。空にすることだけ許す(@codex #420 P2)", () => {
    // 2026-09-08 発注者判断=番号は今後も作らない。番号が入った物件は所在検索の
    // 対象外になり、番号での取得は実サイトへ未配線=**謄本が取れない行き止まり**。
    // ⚠画面から欄を消すだけでは、反映前に開いたままのタブ・直接 API を叩く
    //   クライアントが素通りする。サーバーでも断る。
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "1234567890123" })).toThrow(); // 正しい13桁でも弾く
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "１２３" })).toThrow();
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "あいうえお!!" })).toThrow();
    // ⚠**消す**操作は通す(編集画面の「空にする」が null を送る)
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: null })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "" })).not.toThrow();
    expect(() => createPropertySchema.parse({ ...base, realEstateNumber: "   " })).not.toThrow();
    expect(() => updatePropertySchema.parse({ version: 1, realEstateNumber: null })).not.toThrow();
    expect(() => updatePropertySchema.parse({ version: 1, realEstateNumber: "1234567890123" })).toThrow();
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

// [@codex P2] DECIMAL(p,s) 列は桁あふれを黙って丸める。範囲だけ見て通すと、DB には
// 丸めた値、変更履歴・画面には元の値が残り、同じ項目の値が食い違う。
describe("updatePropertySchema: DECIMAL 列の小数桁(@codex P2)", () => {
  const v = { version: 1 };

  it("DECIMAL(12,1) の金額は小数1桁まで", () => {
    expect(() => updatePropertySchema.parse({ ...v, salePrice: 18800 })).not.toThrow();
    expect(() => updatePropertySchema.parse({ ...v, salePrice: 18800.5 })).not.toThrow();
    expect(() => updatePropertySchema.parse({ ...v, salePrice: 1.25 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, saleTaxAmount: 1.25 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, expectedIncome: 1.25 })).toThrow();
  });

  it("DECIMAL(10,2)/(8,2)/(5,2) は小数2桁まで", () => {
    expect(() => updatePropertySchema.parse({ ...v, landArea: 120.55 })).not.toThrow();
    expect(() => updatePropertySchema.parse({ ...v, landArea: 120.555 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, totalFloorArea: 98.765 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, exclusiveArea: 55.555 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, balconyArea: 8.001 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, grossYield: 4.125 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, grossYield: 4.12 })).not.toThrow();
  });

  it("桁数以外の既存の制約(範囲・null許容)はそのまま", () => {
    expect(() => updatePropertySchema.parse({ ...v, salePrice: null })).not.toThrow();
    expect(() => updatePropertySchema.parse({ ...v, salePrice: -1 })).toThrow();
    expect(() => updatePropertySchema.parse({ ...v, grossYield: 1000 })).toThrow();
  });
});
