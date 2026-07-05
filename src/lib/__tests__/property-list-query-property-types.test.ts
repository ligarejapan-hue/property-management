import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。undeliverable テストと同方式。
const adminSession = { id: "u1", role: "admin" } as never;

describe("propertyListQuerySchema propertyTypes", () => {
  it("カンマ区切りを配列に parse する(空白 trim)", () => {
    const q = propertyListQuerySchema.parse({ propertyTypes: "land, apartment_unit,unit" });
    expect(q.propertyTypes).toEqual(["land", "apartment_unit", "unit"]);
  });

  it("空文字・空要素のみ・未指定は undefined", () => {
    expect(propertyListQuerySchema.parse({ propertyTypes: "" }).propertyTypes).toBeUndefined();
    expect(propertyListQuerySchema.parse({ propertyTypes: " , " }).propertyTypes).toBeUndefined();
    expect(propertyListQuerySchema.parse({}).propertyTypes).toBeUndefined();
  });

  it("不正値を含むと ZodError(route では 422)", () => {
    expect(() => propertyListQuerySchema.parse({ propertyTypes: "land,evil" })).toThrow();
  });
});

describe("buildPropertyListWhere propertyTypes filter", () => {
  it("propertyTypes 指定で propertyType: { in: [...] }", async () => {
    const query = propertyListQuerySchema.parse({ propertyTypes: "land,house" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.propertyType).toEqual({ in: ["land", "house"] });
  });

  it("単一 propertyType と併用時は単一を優先(後方互換)", async () => {
    const query = propertyListQuerySchema.parse({ propertyType: "land", propertyTypes: "house,store" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.propertyType).toBe("land");
  });

  it("未指定なら propertyType フィルタなし(既存挙動不変)", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.propertyType).toBeUndefined();
  });
});
