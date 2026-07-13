import { describe, it, expect } from "vitest";
import { buildPropertyListWhere } from "@/lib/property-list-query";
import { propertyListQuerySchema } from "@/lib/validators";

// A1 (UI総点検): 更新日フィルタが UTC 基準(new Date("YYYY-MM-DD")=UTC 00:00)で、JST 表示と9時間ズレ、
// 「今日」指定で今日更新分が 0 件になっていた。JST(+09:00)の一日境界で解釈するのが正。
const session = { id: "u1", role: "admin" };

describe("buildPropertyListWhere: 更新日フィルタは JST 境界(A1)", () => {
  it("updatedFrom は JST 当日 00:00 を gte にする(UTC 00:00 ではない)", async () => {
    const q = propertyListQuerySchema.parse({ updatedFrom: "2026-07-13" });
    const { where } = await buildPropertyListWhere(q, session);
    // JST 2026-07-13 00:00 = UTC 2026-07-12 15:00
    expect((where.updatedAt.gte as Date).toISOString()).toBe("2026-07-12T15:00:00.000Z");
  });

  it("updatedTo は JST 当日終端(23:59:59.999)を lte にする=当日更新分を含む", async () => {
    const q = propertyListQuerySchema.parse({ updatedTo: "2026-07-13" });
    const { where } = await buildPropertyListWhere(q, session);
    // JST 2026-07-13 23:59:59.999 = UTC 2026-07-13 14:59:59.999
    expect((where.updatedAt.lte as Date).toISOString()).toBe("2026-07-13T14:59:59.999Z");
  });

  it("from/to 両方指定で当日1日ぶんを内包する", async () => {
    const q = propertyListQuerySchema.parse({ updatedFrom: "2026-07-13", updatedTo: "2026-07-13" });
    const { where } = await buildPropertyListWhere(q, session);
    expect((where.updatedAt.gte as Date).toISOString()).toBe("2026-07-12T15:00:00.000Z");
    expect((where.updatedAt.lte as Date).toISOString()).toBe("2026-07-13T14:59:59.999Z");
  });

  it("不正な日付は無視して updatedAt 条件を作らない(空フィルタで全件0を防ぐ)", async () => {
    const q = propertyListQuerySchema.parse({ updatedFrom: "not-a-date", updatedTo: "2026-13-45" });
    const { where } = await buildPropertyListWhere(q, session);
    expect(where.updatedAt).toBeUndefined();
  });
});
