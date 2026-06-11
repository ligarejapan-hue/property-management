/**
 * 21-C PR-1: Property の create/update validator が postalCode（郵便番号）を受理することの検証。
 * postalCode は nullable・optional＝未指定でも既存挙動が壊れない。
 * （Property の create/update route は parse 済みデータを prisma へ spread するため、
 *  validator が受理＝保存先へ渡る。Building は inline schema のため route テストで担保。）
 */
import { describe, it, expect } from "vitest";
import {
  createPropertySchema,
  updatePropertySchema,
} from "@/lib/validators";

describe("createPropertySchema postalCode（21-C PR-1）", () => {
  it("postalCode（文字列）を受理し、parse 結果に含む", () => {
    const parsed = createPropertySchema.parse({
      propertyType: "land",
      address: "東京都千代田区丸の内1-1-1",
      postalCode: "1000005",
    });
    expect(parsed.postalCode).toBe("1000005");
  });

  it("postalCode=null を受理する", () => {
    const parsed = createPropertySchema.parse({
      propertyType: "land",
      address: "東京都千代田区",
      postalCode: null,
    });
    expect(parsed.postalCode).toBeNull();
  });

  it("postalCode 未指定でも parse 成功（既存挙動が壊れない）", () => {
    const parsed = createPropertySchema.parse({
      propertyType: "land",
      address: "東京都千代田区",
    });
    expect(parsed.address).toBe("東京都千代田区");
    expect(parsed.postalCode ?? null).toBeNull();
  });
});

describe("updatePropertySchema postalCode（21-C PR-1）", () => {
  it("postalCode（文字列）を受理し、parse 結果に含む", () => {
    const parsed = updatePropertySchema.parse({
      version: 1,
      postalCode: "1000005",
    });
    expect(parsed.postalCode).toBe("1000005");
  });

  it("postalCode=null を受理する（クリア）", () => {
    const parsed = updatePropertySchema.parse({
      version: 1,
      postalCode: null,
    });
    expect(parsed.postalCode).toBeNull();
  });

  it("postalCode 未指定でも parse 成功（既存挙動が壊れない）", () => {
    const parsed = updatePropertySchema.parse({
      version: 2,
      address: "新住所",
    });
    expect(parsed.address).toBe("新住所");
    expect(parsed.postalCode ?? null).toBeNull();
  });
});
