import { describe, it, expect } from "vitest";
import { updatePropertySchema } from "@/lib/validators";
import { ZodError } from "zod";

// updatePropertySchema の販売区分フィールドに範囲検証を追加（F3 Task7 fix）。
// DB の桁制限(DECIMAL/INT)を超える値や不適切な値が 422 エラーになることを
// Zod スキーマで固定。

describe("updatePropertySchema — 販売区分フィールドの範囲検証(F3 Task7 fix)", () => {
  function expectValid(data: unknown) {
    expect(() => updatePropertySchema.parse(data)).not.toThrow();
  }

  function expectInvalid(data: unknown) {
    expect(() => updatePropertySchema.parse(data)).toThrow(ZodError);
  }

  describe("金額フィールド(万円単位・DECIMAL(12,1))のバリデーション", () => {
    it("salePrice: 0〜99999999999 の範囲で受け付ける", () => {
      expectValid({ salePrice: 50000000, version: 1 });
    });

    it("salePrice: 負の値は無効", () => {
      expectInvalid({ salePrice: -1, version: 1 });
    });

    it("salePrice: 99999999999 超過は無効", () => {
      expectInvalid({ salePrice: 100000000000, version: 1 });
    });

    it("saleTaxAmount: 0〜99999999999 の範囲で受け付ける", () => {
      expectValid({ saleTaxAmount: 5000000, version: 1 });
    });

    it("saleTaxAmount: 負の値は無効", () => {
      expectInvalid({ saleTaxAmount: -1, version: 1 });
    });

    it("expectedIncome: 0〜99999999999 の範囲で受け付ける", () => {
      expectValid({ expectedIncome: 2000000, version: 1 });
    });

    it("expectedIncome: 負の値は無効", () => {
      expectInvalid({ expectedIncome: -1, version: 1 });
    });
  });

  describe("面積フィールド(㎡・DECIMAL(10,2))のバリデーション", () => {
    it("landArea: 0〜99999999 の範囲で受け付ける", () => {
      expectValid({ landArea: 100.5, version: 1 });
    });

    it("landArea: 負の値は無効", () => {
      expectInvalid({ landArea: -0.1, version: 1 });
    });

    it("landArea: 99999999 超過は無効", () => {
      expectInvalid({ landArea: 100000000, version: 1 });
    });

    it("totalFloorArea: 0〜99999999 の範囲で受け付ける", () => {
      expectValid({ totalFloorArea: 200.5, version: 1 });
    });

    it("totalFloorArea: 負の値は無効", () => {
      expectInvalid({ totalFloorArea: -0.1, version: 1 });
    });

    it("exclusiveArea: 0〜999999 の範囲で受け付ける", () => {
      expectValid({ exclusiveArea: 60.5, version: 1 });
    });

    it("exclusiveArea: 負の値は無効", () => {
      expectInvalid({ exclusiveArea: -1, version: 1 });
    });

    it("balconyArea: 0〜999999 の範囲で受け付ける", () => {
      expectValid({ balconyArea: 10.5, version: 1 });
    });

    it("balconyArea: 負の値は無効", () => {
      expectInvalid({ balconyArea: -1, version: 1 });
    });
  });

  describe("利回りフィールド(DECIMAL(5,2)・%)のバリデーション", () => {
    it("grossYield: 0〜999.99 の範囲で受け付ける", () => {
      expectValid({ grossYield: 5.5, version: 1 });
    });

    it("grossYield: 負の値は無効", () => {
      expectInvalid({ grossYield: -0.1, version: 1 });
    });

    it("grossYield: 999.99 超過は無効（例: 12345%）", () => {
      expectInvalid({ grossYield: 12345, version: 1 });
    });
  });

  describe("階数フィールド(INT)のバリデーション", () => {
    it("aboveFloors: 0〜200 の範囲で受け付ける", () => {
      expectValid({ aboveFloors: 10, version: 1 });
    });

    it("aboveFloors: 負の値は無効", () => {
      expectInvalid({ aboveFloors: -1, version: 1 });
    });

    it("aboveFloors: 200 超過は無効", () => {
      expectInvalid({ aboveFloors: 201, version: 1 });
    });

    it("basementFloors: 0〜20 の範囲で受け付ける", () => {
      expectValid({ basementFloors: 1, version: 1 });
    });

    it("basementFloors: 負の値は無効", () => {
      expectInvalid({ basementFloors: -1, version: 1 });
    });

    it("basementFloors: 20 超過は無効", () => {
      expectInvalid({ basementFloors: 21, version: 1 });
    });

    it("floorNo: -10〜200 の範囲で受け付ける（地下の部屋対応）", () => {
      expectValid({ floorNo: -2, version: 1 });
    });

    it("floorNo: -10 未満は無効", () => {
      expectInvalid({ floorNo: -11, version: 1 });
    });

    it("floorNo: 200 超過は無効", () => {
      expectInvalid({ floorNo: 201, version: 1 });
    });
  });

  describe("戸数フィールド(INT)のバリデーション", () => {
    it("totalUnits: 0〜9999 の範囲で受け付ける", () => {
      expectValid({ totalUnits: 50, version: 1 });
    });

    it("totalUnits: 負の値は無効", () => {
      expectInvalid({ totalUnits: -1, version: 1 });
    });

    it("totalUnits: 9999 超過は無効", () => {
      expectInvalid({ totalUnits: 10000, version: 1 });
    });
  });

  describe("年月フィールドのバリデーション", () => {
    it("builtYear: 1800〜2200 の範囲で受け付ける", () => {
      expectValid({ builtYear: 2015, version: 1 });
    });

    it("builtYear: 1800 未満は無効", () => {
      expectInvalid({ builtYear: 1799, version: 1 });
    });

    it("builtYear: 2200 超過は無効", () => {
      expectInvalid({ builtYear: 2201, version: 1 });
    });

    it("builtMonth: 1〜12 の範囲で受け付ける", () => {
      expectValid({ builtMonth: 3, version: 1 });
    });

    it("builtMonth: 13以上は無効", () => {
      expectInvalid({ builtMonth: 13, version: 1 });
    });

    it("builtMonth: 0以下は無効", () => {
      expectInvalid({ builtMonth: 0, version: 1 });
    });
  });

  describe("料金フィールド(円・INT)のバリデーション", () => {
    it("managementFee: 0〜10000000 の範囲で受け付ける", () => {
      expectValid({ managementFee: 15000, version: 1 });
    });

    it("managementFee: 負の値は無効", () => {
      expectInvalid({ managementFee: -1, version: 1 });
    });

    it("managementFee: 10000000 超過は無効", () => {
      expectInvalid({ managementFee: 10000001, version: 1 });
    });

    it("repairReserveFee: 0〜10000000 の範囲で受け付ける", () => {
      expectValid({ repairReserveFee: 10000, version: 1 });
    });

    it("repairReserveFee: 負の値は無効", () => {
      expectInvalid({ repairReserveFee: -1, version: 1 });
    });
  });

  describe("文字数制限のバリデーション", () => {
    it("structureType: 50文字以下で受け付ける", () => {
      expectValid({ structureType: "RC造", version: 1 });
    });

    it("structureType: 50文字超過は無効", () => {
      expectInvalid({ structureType: "あ".repeat(51), version: 1 });
    });

    it("layoutType: 50文字以下で受け付ける", () => {
      expectValid({ layoutType: "1LDK", version: 1 });
    });

    it("layoutType: 50文字超過は無効", () => {
      expectInvalid({ layoutType: "あ".repeat(51), version: 1 });
    });

    it("orientation: 50文字以下で受け付ける", () => {
      expectValid({ orientation: "南向き", version: 1 });
    });

    it("parking: 50文字以下で受け付ける", () => {
      expectValid({ parking: "月額5000円", version: 1 });
    });

    it("saleTaxType: 50文字以下で受け付ける", () => {
      expectValid({ saleTaxType: "消費税込", version: 1 });
    });

    it("landAreaMethod: 50文字以下で受け付ける", () => {
      expectValid({ landAreaMethod: "登記簿", version: 1 });
    });

    it("access: 200文字以下で受け付ける（自由記述）", () => {
      expectValid({ access: "駅から徒歩5分、バス停から2分", version: 1 });
    });

    it("access: 200文字超過は無効", () => {
      expectInvalid({ access: "あ".repeat(201), version: 1 });
    });

    it("orientation: 50文字超過は無効（将来の防御）", () => {
      expectInvalid({ orientation: "あ".repeat(51), version: 1 });
    });

    it("parking: 50文字超過は無効（将来の防御）", () => {
      expectInvalid({ parking: "あ".repeat(51), version: 1 });
    });

    it("saleTaxType: 50文字超過は無効（将来の防御）", () => {
      expectInvalid({ saleTaxType: "あ".repeat(51), version: 1 });
    });

    it("landAreaMethod: 50文字超過は無効（将来の防御）", () => {
      expectInvalid({ landAreaMethod: "あ".repeat(51), version: 1 });
    });
  });
});
