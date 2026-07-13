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

  it("dmSentMax=2 → N回超の物件を groupBy で除外(id notIn)", async () => {
    const q = propertyListQuerySchema.parse({ dmSentMax: "2" });
    const groupBy = vi
      .fn()
      .mockResolvedValue([{ propertyId: "p-over-1" }, { propertyId: "p-over-2" }]);
    const client = { propertyDmLog: { groupBy } } as never;
    const { where } = await buildPropertyListWhere(q, session, client);
    expect(groupBy).toHaveBeenCalledTimes(1);
    // 現在のクエリの物件だけを数える(全ログ走査を避ける・Codex P2)。
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { property: expect.anything() } }),
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([{ id: { notIn: ["p-over-1", "p-over-2"] } }]),
    );
  });

  it("dmSentMax=2 で N回超が0件 → 余計な id 条件を足さない", async () => {
    const q = propertyListQuerySchema.parse({ dmSentMax: "2" });
    const client = { propertyDmLog: { groupBy: vi.fn().mockResolvedValue([]) } } as never;
    const { where } = await buildPropertyListWhere(q, session, client);
    const hasIdNotIn = (where.AND ?? []).some(
      (c: { id?: { notIn?: unknown } }) => c.id && "notIn" in (c.id ?? {}),
    );
    expect(hasIdNotIn).toBe(false);
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
