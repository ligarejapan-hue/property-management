/**
 * 同じ内容の物件を探す(査定ナンバーの無い依頼の二重登録・2026-11-15)。
 * ⚠見る人の権限・担当では絞らない(登録APIが止めるために使う)。渡されたクライアントだけで引く。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("global prisma must not be used"); } }),
}));

import { findSameContentProperties } from "../paste-import-duplicates";

type Row = {
  id: string;
  address: string;
  lotNumber: string | null;
  buildingName: string | null;
  roomNo: string | null;
  owners: { name: string; isArchived?: boolean }[];
};

function fakeDb(rows: Row[]) {
  const findMany = vi.fn(async (args: unknown) => {
    void args;
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      lotNumber: r.lotNumber,
      buildingName: r.buildingName,
      roomNo: r.roomNo,
      createdBy: "someone-else",
      assignedTo: null,
      propertyOwners: r.owners.map((o) => ({ owner: { name: o.name, isArchived: o.isArchived ?? false } })),
    }));
  });
  return { findMany, db: { property: { findMany } } };
}

const input = {
  address: "東京都港区1-1",
  lotNumber: null,
  buildingName: "テストマンション",
  roomNo: "901",
  ownerName: "調査　太郎",
};
const row = (over: Partial<Row> = {}): Row => ({
  id: "p1",
  address: "東京都港区１－１",
  lotNumber: null,
  buildingName: "テストマンション",
  roomNo: "９０１",
  owners: [{ name: "調査太郎" }],
  ...over,
});

describe("findSameContentProperties", () => {
  it("★担当に関係なく、同じ内容の物件を返す(作った人・担当が別でも)", async () => {
    const { db } = fakeDb([row(), row({ id: "p2", roomNo: "902" })]);
    const r = await findSameContentProperties(db as never, input);
    expect(r.matches.map((m) => m.id)).toEqual(["p1"]);
    expect(r.truncated).toBe(false);
  });

  it("★保管済みの所有者の名前では当てない", async () => {
    const { db } = fakeDb([row({ owners: [{ name: "調査太郎", isArchived: true }] })]);
    expect((await findSameContentProperties(db as never, input)).matches).toEqual([]);
  });

  it("★所有者の名前・住所が無ければ DB を引かない", async () => {
    const { db, findMany } = fakeDb([row()]);
    expect((await findSameContentProperties(db as never, { ...input, ownerName: null })).matches).toEqual([]);
    expect((await findSameContentProperties(db as never, { ...input, address: " " })).matches).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("★保管していない物件だけを、同じ名前の所有者がつながっているものに絞って引く", async () => {
    const { db, findMany } = fakeDb([]);
    await findSameContentProperties(db as never, input);
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.isArchived).toBe(false);
    expect(JSON.stringify(where.propertyOwners)).toContain('"isArchived":false');
    expect(JSON.stringify(where.propertyOwners)).toContain("調");
  });

  it("取りきれなかったら truncated(「無い」と同じ顔をさせない)", async () => {
    const many = Array.from({ length: 300 }, (_, i) => row({ id: `p${i}`, roomNo: String(i + 1000) }));
    const { db } = fakeDb(many);
    expect((await findSameContentProperties(db as never, input)).truncated).toBe(true);
  });
});
