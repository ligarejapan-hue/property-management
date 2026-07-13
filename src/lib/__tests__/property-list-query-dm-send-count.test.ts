import { describe, it, expect, vi } from "vitest";
import {
  buildPropertyListOrderBy,
  buildPropertyListWhere,
} from "@/lib/property-list-query";
import { propertyListQuerySchema } from "@/lib/validators";

const session = { id: "u1", role: "admin" };

describe("property-list-query: DM送信回数の並べ替え/抽出", () => {
  it("sortBy=dmSendCount → dmLogs の件数で並べ替える", () => {
    const q = propertyListQuerySchema.parse({ sortBy: "dmSendCount", sortOrder: "asc" });
    expect(buildPropertyListOrderBy(q)).toEqual({ dmLogs: { _count: "asc" } });
  });

  it("従来の sortBy はそのまま列で並べ替える", () => {
    const q = propertyListQuerySchema.parse({ sortBy: "address", sortOrder: "desc" });
    expect(buildPropertyListOrderBy(q)).toEqual({ address: "desc" });
  });

  it("dmSentMax=0 → 未送信のみ(dmLogs none)。groupBy は呼ばない", async () => {
    const q = propertyListQuerySchema.parse({ dmSentMax: "0" });
    const groupBy = vi.fn();
    const client = { propertyDmLog: { groupBy } } as never;
    const { where } = await buildPropertyListWhere(q, session, client);
    expect(where.AND).toEqual(expect.arrayContaining([{ dmLogs: { none: {} } }]));
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("dmSentMax は 0(未送信)のみ許可。N回以下(1/2/3)は廃止=スキーマが弾く(@codex R10-P2)", () => {
    expect(propertyListQuerySchema.parse({ dmSentMax: "0" }).dmSentMax).toBe(0);
    expect(() => propertyListQuerySchema.parse({ dmSentMax: "1" })).toThrow();
    expect(() => propertyListQuerySchema.parse({ dmSentMax: "3" })).toThrow();
  });

  it("dmSentMax 未指定 → DM送信回数の絞りを足さない", async () => {
    const q = propertyListQuerySchema.parse({});
    const client = { propertyDmLog: { groupBy: vi.fn() } } as never;
    const { where } = await buildPropertyListWhere(q, session, client);
    const hasDmFilter = (where.AND ?? []).some(
      (c: { dmLogs?: unknown; id?: { notIn?: unknown } }) =>
        c.dmLogs || (c.id && "notIn" in (c.id ?? {})),
    );
    expect(hasDmFilter).toBe(false);
  });
});
