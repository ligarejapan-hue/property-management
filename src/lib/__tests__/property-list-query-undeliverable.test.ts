import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "../property-list-query";
import { propertyListQuerySchema } from "../validators";

// session は admin 相当(レコード絞り込みが無い形)。
const adminSession = { id: "u1", role: "admin" } as never;

describe("buildPropertyListWhere undeliverable filter", () => {
  it("undeliverable=1 で dmUndeliverableAt: { not: null } を付ける", async () => {
    const query = propertyListQuerySchema.parse({ undeliverable: "1" });
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmUndeliverableAt).toEqual({ not: null });
  });

  it("undeliverable 未指定なら dmUndeliverableAt フィルタを付けない", async () => {
    const query = propertyListQuerySchema.parse({});
    const { where } = await buildPropertyListWhere(query, adminSession);
    expect(where.dmUndeliverableAt).toBeUndefined();
  });
});
