/**
 * 取込の取り消しで、その取込が自動で作った棟のうち空になったものを消す(@codex P1・2026-10-05)。
 *
 * - 目印は監査ログ `building.auto_create` の detail.importJobId(migration を足さない)。
 * - 消すのは「行ロックを取れて、部屋も棟の写真も 0」の棟だけ。
 * - ロックは FOR UPDATE SKIP LOCKED(誰かがその棟を使っている最中なら待たずに残す=待ちの輪を作らない)。
 */
import { describe, it, expect, vi } from "vitest";
import {
  findImportAutoCreatedBuildingIds,
  removeEmptyAutoCreatedBuildings,
  type RollbackBuildingTx,
} from "@/lib/building-link/rollback";

const B1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B3 = "aaaaaaaa-0000-4000-8000-000000000003";
const B4 = "aaaaaaaa-0000-4000-8000-000000000004";

type Row = { id: string; properties: number; photos: number; locked: boolean };

function fakeTx(rows: Row[]) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (q: TemplateStringsArray, ...v: unknown[]) => {
      sql.push(q.join("?"));
      const ids = v[0] as string[];
      return rows.filter((r) => ids.includes(r.id) && !r.locked).map((r) => ({ id: r.id }));
    }),
    building: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        rows
          .filter((r) => where.id.in.includes(r.id))
          .map((r) => ({ id: r.id, _count: { properties: r.properties, photos: r.photos } })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length })),
    },
  };
  return { tx: tx as typeof tx & RollbackBuildingTx, sql };
}

describe("removeEmptyAutoCreatedBuildings", () => {
  it("空の棟だけ消し、部屋・写真がある棟と使用中(ロックを取れない)の棟は残して理由を返す", async () => {
    const { tx, sql } = fakeTx([
      { id: B1, properties: 0, photos: 0, locked: false },
      { id: B2, properties: 1, photos: 0, locked: false },
      { id: B3, properties: 0, photos: 2, locked: false },
      { id: B4, properties: 0, photos: 0, locked: true },
    ]);
    const r = await removeEmptyAutoCreatedBuildings(tx, [B2, B1, B3, B4, B1.toUpperCase()]);
    expect(r.deletedBuildingIds).toEqual([B1]);
    expect(r.keptBuildings).toEqual([
      { buildingId: B2, reason: "has_properties" },
      { buildingId: B3, reason: "has_photos" },
      { buildingId: B4, reason: "in_use" },
    ]);
    expect(tx.building.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [B1] } } });
    // ロックは id 昇順・SKIP LOCKED・小文字にそろえた重複なしの id
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/FROM buildings WHERE id = ANY\(\?::uuid\[\]\) ORDER BY id FOR UPDATE SKIP LOCKED/);
    expect(tx.$queryRaw.mock.calls[0][1]).toEqual([B1, B2, B3, B4]);
    // 数えるのはロックの後
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.building.findMany.mock.invocationCallOrder[0]);
  });

  it("もう無い棟は何もしない・候補が空なら DB に触らない", async () => {
    const { tx } = fakeTx([]);
    expect(await removeEmptyAutoCreatedBuildings(tx, [B1])).toEqual({ deletedBuildingIds: [], keptBuildings: [] });
    expect(tx.building.deleteMany).not.toHaveBeenCalled();
    const empty = fakeTx([]);
    await removeEmptyAutoCreatedBuildings(empty.tx, []);
    expect(empty.tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("findImportAutoCreatedBuildingIds", () => {
  it("この取込の building.auto_create だけを id で引き、重複を除いて小文字で返す", async () => {
    const findMany = vi.fn(async () => [{ targetId: B1.toUpperCase() }, { targetId: B1 }, { targetId: null }, { targetId: B2 }]);
    const ids = await findImportAutoCreatedBuildingIds({ auditLog: { findMany } }, "job-1");
    expect(ids).toEqual([B1, B2]);
    expect(findMany).toHaveBeenCalledWith({
      where: { action: "building.auto_create", targetTable: "buildings", detail: { path: ["importJobId"], equals: "job-1" } },
      select: { targetId: true },
    });
  });
});
