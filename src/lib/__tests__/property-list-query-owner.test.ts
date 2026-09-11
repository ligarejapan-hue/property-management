import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。
const adminSession = { id: "u1", role: "admin" } as never;
const fieldSession = { id: "u9", role: "field_staff" } as never;
const OWNER = "11111111-1111-4111-8111-111111111111";

describe("buildPropertyListWhere ownerId フィルタ", () => {
  it("ownerId 指定で propertyOwners.some.ownerId を AND に足す", async () => {
    const query = propertyListQuerySchema.parse({ ownerId: OWNER });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
  });

  it("ownerId 未指定なら所有者条件を足さない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(JSON.stringify(where.AND ?? [])).not.toContain("propertyOwners");
  });

  it("keyword と併用しても OR ではなく AND に入る(担当外の物件が漏れない)", async () => {
    const query = propertyListQuerySchema.parse({
      ownerId: OWNER,
      keyword: "世田谷",
    });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(JSON.stringify(where.OR ?? [])).not.toContain("propertyOwners");
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
  });

  it("field_staff のスコープと同時に効く(片方に置き換わらない)", async () => {
    const query = propertyListQuerySchema.parse({ ownerId: OWNER });
    const { where } = await buildPropertyListWhere(query, fieldSession);
    expect(where.AND).toContainEqual({
      propertyOwners: { some: { ownerId: OWNER } },
    });
    expect(where.AND).toContainEqual({
      OR: [{ createdBy: "u9" }, { assignedTo: "u9" }],
    });
  });

  it("UUID でない ownerId は schema が弾く", () => {
    expect(() =>
      propertyListQuerySchema.parse({ ownerId: "'; drop table--" }),
    ).toThrow();
  });

  it("空文字の ownerId は schema が弾く(絞り込み無しに化けさせない)", () => {
    expect(() => propertyListQuerySchema.parse({ ownerId: "" })).toThrow();
  });
});
