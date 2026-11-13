import { describe, expect, it, vi } from "vitest";

import { TERMINAL_REACTIONS } from "@/lib/dm-reaction/core";

import { dmExclusionReason, findTerminalExclusions, isTerminalExcluded } from "../terminal-exclusion";

/**
 * 拒否・宛先不明(terminal 反響)の除外セット構築と判定。
 *
 * ⚠これは **宛名CSV(A)と売却DM(B)の両方が使う唯一の実装**。2026-08-16 に
 * 「A にはある除外が B に無い」穴が見つかった([[dm-sending-management]])。同じ条件を
 * 2 か所に書くと必ずずれるので、集合の作り方と判定をここに 1 本化する。
 */

type FindArgs = {
  where: {
    AND: [unknown, { OR: unknown[] }];
  };
  select: unknown;
};

const fakeTx = (
  rows: Array<{ ownerId: string | null; propertyId: string | null; logOwners: { ownerId: string }[] }>,
  agentOwnerIds: string[] = [],
  gaijiOwnerIds: string[] = [],
) => {
  const findMany = vi.fn(async (_args: FindArgs) => rows);
  // 業者と同じ名前の所有者(agent-name-exclusion.ts の SQL の結果)
  // 名前に外字がある所有者も同じ SQL の結果に agent/gaiji の印つきで返る(2026-11-11)
  const $queryRaw = vi.fn(async () => [
    ...agentOwnerIds.map((id) => ({ id, agent: true, gaiji: gaijiOwnerIds.includes(id) })),
    ...gaijiOwnerIds.filter((id) => !agentOwnerIds.includes(id)).map((id) => ({ id, agent: false, gaiji: true })),
  ]);
  return { tx: { propertyDmLog: { findMany }, $queryRaw: $queryRaw as never }, findMany, $queryRaw };
};

describe("findTerminalExclusions（集合の構築）", () => {
  it("terminal 2種(refused/undeliverable)だけを対象に、3経路のORで引く", async () => {
    const { tx, findMany } = fakeTx([]);
    await findTerminalExclusions(tx, ["o2", "o1", "o1"], ["p2", "p1", "p2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as FindArgs;
    // ⚠外す理由になる記録=拒否(印に関係なく) と 解除していない宛先不明(2026-11-13)。
    //   住所を替えて解除した宛先不明は外さない。拒否は別の枝=解除の印では解けない。
    expect(args.where.AND[0]).toEqual({
      OR: [
        { reactionStatus: "refused" },
        { reactionStatus: "undeliverable", undeliverableClearedAt: null },
      ],
    });
    expect([...TERMINAL_REACTIONS]).toEqual(["refused", "undeliverable"]);
    // 経路① 代表 owner_id ② 共有者連関 log_owners ③ 所有者紐づけの無い物件単位
    expect(args.where.AND[1].OR).toEqual([
      { ownerId: { in: ["o1", "o2"] } },
      { logOwners: { some: { ownerId: { in: ["o1", "o2"] } } } },
      { propertyId: { in: ["p1", "p2"] }, ownerId: null, logOwners: { none: {} } },
    ]);
  });

  it("両方とも空なら DB を引かず空集合を返す（A の既存ガードと同じ）", async () => {
    const { tx, findMany, $queryRaw } = fakeTx([]);
    const sets = await findTerminalExclusions(tx, [], []);
    expect(findMany).not.toHaveBeenCalled();
    expect($queryRaw).not.toHaveBeenCalled();
    expect(sets.agentOwnerIds.size).toBe(0);
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

  it("業者と同じ名前の所有者は別の集合へ(所有者がいれば必ず照会する)", async () => {
    const { tx, $queryRaw } = fakeTx([], ["o2"]);
    const sets = await findTerminalExclusions(tx, ["o1", "o2"], ["p1"]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect([...sets.agentOwnerIds]).toEqual(["o2"]);
    expect(sets.ownerIds.size).toBe(0);
  });

  it("名前に外字がある所有者は別の集合へ(同じ SQL 1本・業者の集合には入れない)", async () => {
    const { tx, $queryRaw } = fakeTx([], ["o2"], ["o3"]);
    const sets = await findTerminalExclusions(tx, ["o1", "o2", "o3"], ["p1"]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect([...sets.agentOwnerIds]).toEqual(["o2"]);
    expect([...sets.gaijiOwnerIds]).toEqual(["o3"]);
  });
});

describe("isTerminalExcluded（宛先グループの判定）", () => {
  const sets = {
    ownerIds: new Set(["oBad"]),
    propertyIds: new Set(["pBad"]),
    agentOwnerIds: new Set(["oAgent"]),
    gaijiOwnerIds: new Set(["oGaiji"]),
  };

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

  it("名前に外字がある所有者が代表でも共有者でも除外", () => {
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oGaiji"] })).toBe(true);
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oOk", "oGaiji"] })).toBe(true);
  });
});

describe("dmExclusionReason（外す理由）", () => {
  const sets = {
    ownerIds: new Set(["oBad"]),
    propertyIds: new Set(["pBad"]),
    agentOwnerIds: new Set(["oAgent", "oBad"]),
    gaijiOwnerIds: new Set(["oGaiji", "oAgent", "oBad"]),
  };

  it("業者と同じ名前の所有者が代表でも共有者でも外す(住所に関係なく)", () => {
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oAgent"] })).toBe("agent_name");
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oOk", "oAgent"] })).toBe("agent_name");
    expect(isTerminalExcluded(sets, { propertyId: "p1", ownerIds: ["oOk", "oAgent"] })).toBe(true);
  });
  it("両方に当たるときは拒否・宛先不明を理由にする", () => {
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oBad"] })).toBe("terminal");
    expect(dmExclusionReason(sets, { propertyId: "pBad", ownerIds: ["oAgent"] })).toBe("terminal");
  });
  it("名前に外字がある所有者=gaiji_name(拒否・宛先不明と業者と同じ名前を先に見る)", () => {
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oGaiji"] })).toBe("gaiji_name");
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oOk", "oGaiji"] })).toBe("gaiji_name");
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oAgent"] })).toBe("agent_name");
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oBad"] })).toBe("terminal");
  });
  it("どれにも当たらなければ null", () => {
    expect(dmExclusionReason(sets, { propertyId: "p1", ownerIds: ["oOk"] })).toBeNull();
  });
});
