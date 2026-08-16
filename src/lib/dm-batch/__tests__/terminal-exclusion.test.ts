import { describe, expect, it, vi } from "vitest";

import { TERMINAL_REACTIONS } from "@/lib/dm-reaction/core";

import { findTerminalExclusions, isTerminalExcluded } from "../terminal-exclusion";

/**
 * 拒否・宛先不明(terminal 反響)の除外セット構築と判定。
 *
 * ⚠これは **宛名CSV(A)と売却DM(B)の両方が使う唯一の実装**。2026-08-16 に
 * 「A にはある除外が B に無い」穴が見つかった([[dm-sending-management]])。同じ条件を
 * 2 か所に書くと必ずずれるので、集合の作り方と判定をここに 1 本化する。
 */

type FindArgs = {
  where: {
    reactionStatus: { in: string[] };
    OR: unknown[];
  };
  select: unknown;
};

const fakeTx = (rows: Array<{ ownerId: string | null; propertyId: string | null; logOwners: { ownerId: string }[] }>) => {
  const findMany = vi.fn(async (_args: FindArgs) => rows);
  return { tx: { propertyDmLog: { findMany } }, findMany };
};

describe("findTerminalExclusions（集合の構築）", () => {
  it("terminal 2種(refused/undeliverable)だけを対象に、3経路のORで引く", async () => {
    const { tx, findMany } = fakeTx([]);
    await findTerminalExclusions(tx, ["o2", "o1", "o1"], ["p2", "p1", "p2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as FindArgs;
    expect(args.where.reactionStatus.in).toEqual([...TERMINAL_REACTIONS]);
    expect(args.where.reactionStatus.in).toEqual(["refused", "undeliverable"]);
    // 経路① 代表 owner_id ② 共有者連関 log_owners ③ 所有者紐づけの無い物件単位
    expect(args.where.OR).toEqual([
      { ownerId: { in: ["o1", "o2"] } },
      { logOwners: { some: { ownerId: { in: ["o1", "o2"] } } } },
      { propertyId: { in: ["p1", "p2"] }, ownerId: null, logOwners: { none: {} } },
    ]);
  });

  it("両方とも空なら DB を引かず空集合を返す（A の既存ガードと同じ）", async () => {
    const { tx, findMany } = fakeTx([]);
    const sets = await findTerminalExclusions(tx, [], []);
    expect(findMany).not.toHaveBeenCalled();
    expect(sets.ownerIds.size).toBe(0);
    expect(sets.propertyIds.size).toBe(0);
  });

  it("所有者に紐づく記録は所有者集合へ・紐づかない記録だけ物件集合へ", async () => {
    const { tx } = fakeTx([
      { ownerId: "o1", propertyId: "pX", logOwners: [] },
      { ownerId: null, propertyId: "pY", logOwners: [{ ownerId: "o3" }] },
      { ownerId: null, propertyId: "p9", logOwners: [] },
    ]);
    const sets = await findTerminalExclusions(tx, ["o1", "o3"], ["p9"]);
    expect([...sets.ownerIds].sort()).toEqual(["o1", "o3"]);
    // pX/pY は所有者へ紐づいたので物件集合には入れない(A の分類と同一)
    expect([...sets.propertyIds]).toEqual(["p9"]);
  });
});

describe("isTerminalExcluded（宛先グループの判定）", () => {
  const sets = { ownerIds: new Set(["oBad"]), propertyIds: new Set(["pBad"]) };

  it("代表・共有者のどちらかが terminal なら除外", () => {
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oBad"] })).toBe(true);
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oOk", "oBad"] })).toBe(true);
  });

  it("物件単位の terminal（所有者紐づけ無しの拒否）でも除外", () => {
    expect(isTerminalExcluded(sets, { propertyId: "pBad", ownerIds: ["oOk"] })).toBe(true);
  });

  it("どれにも当たらなければ残す", () => {
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oOk"] })).toBe(false);
  });
});
