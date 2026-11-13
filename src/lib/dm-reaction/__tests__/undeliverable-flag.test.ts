import { describe, it, expect, vi } from "vitest";
import { countActiveUndeliverable } from "@/lib/dm-reaction/undeliverable-flag";

/**
 * 物件の「宛先不明」の印を残すかどうかの数え方(2026-11-13・宛先不明の解除にあわせて一本化)。
 * 解除した宛先不明の記録と、その記録につながる売却DMの宛先の返戻は数えない。
 */
const makeTx = (opts: { clearedDraftIds?: Array<string | null>; logCount?: number; draftCount?: number } = {}) => {
  const tx = {
    propertyDmLog: {
      findMany: vi.fn(async () => (opts.clearedDraftIds ?? []).map((draftId) => ({ draftId }))),
      count: vi.fn(async () => opts.logCount ?? 0),
    },
    dmRecipientDraft: {
      count: vi.fn(async (_args: { where: { id: { notIn: string[] } } }) => opts.draftCount ?? 0),
    },
  };
  return tx;
};

describe("countActiveUndeliverable", () => {
  it("記録は「解除していない宛先不明」だけを数える", async () => {
    const tx = makeTx({ logCount: 2 });
    expect(await countActiveUndeliverable(tx, "p1")).toBe(2);
    expect(tx.propertyDmLog.count).toHaveBeenCalledWith({
      where: { propertyId: "p1", reactionStatus: "undeliverable", undeliverableClearedAt: null },
    });
  });

  it("⚠解除済みの記録につながる売却DMの宛先の返戻は数えない(記録だけ解除しても印が残る、を防ぐ)", async () => {
    const tx = makeTx({ clearedDraftIds: ["d2", "d1", "d1", null], draftCount: 1 });
    expect(await countActiveUndeliverable(tx, "p1")).toBe(1);
    expect(tx.propertyDmLog.findMany).toHaveBeenCalledWith({
      where: {
        propertyId: "p1",
        reactionStatus: "undeliverable",
        undeliverableClearedAt: { not: null },
        draftId: { not: null },
      },
      select: { draftId: true },
    });
    expect(tx.dmRecipientDraft.count).toHaveBeenCalledWith({
      where: {
        propertyId: "p1",
        status: "sent",
        deliveryStatus: "returned_undeliverable",
        id: { notIn: ["d1", "d2"] },
      },
    });
  });

  it("今変える記録・今変える売却DMの宛先は数えない", async () => {
    const tx = makeTx();
    await countActiveUndeliverable(tx, "p1", { logId: "log-9", draftId: "d9" });
    expect(tx.propertyDmLog.count).toHaveBeenCalledWith({
      where: {
        propertyId: "p1",
        reactionStatus: "undeliverable",
        undeliverableClearedAt: null,
        id: { not: "log-9" },
      },
    });
    expect(tx.dmRecipientDraft.count.mock.calls[0][0].where.id).toEqual({ notIn: ["d9"] });
  });

  it("記録と宛先の合計を返す", async () => {
    expect(await countActiveUndeliverable(makeTx({ logCount: 1, draftCount: 2 }), "p1")).toBe(3);
    expect(await countActiveUndeliverable(makeTx(), "p1")).toBe(0);
  });
});
