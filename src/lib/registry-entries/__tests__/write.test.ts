import { describe, it, expect, vi } from "vitest";
import { planRegistryEntries, replaceRegistryEntries } from "@/lib/registry-entries/write";

/**
 * 登記上の記載(所有者事項の行ごとの住所と持分)の記録(2026-11-12 発注者決定)。
 * 同じ人が住所違い・持分ごとに何行も載るとき、所有者は1人のまま行を残す。
 */
describe("planRegistryEntries", () => {
  it("同じ人の3行を、行の順のまま1人にまとめる(position は書類全体の順)", () => {
    const plan = planRegistryEntries([
      { ownerId: "a", address: "住所A", share: "10分の2" },
      { ownerId: "b", address: "住所X", share: "10分の3" },
      { ownerId: "a", address: "住所B", share: "10分の3" },
      { ownerId: "a", address: " 住所C ", share: "10分の2" },
    ]);
    expect(plan.get("a")).toEqual([
      { position: 1, address: "住所A", shareNum: 2, shareDen: 10 },
      { position: 3, address: "住所B", shareNum: 3, shareDen: 10 },
      { position: 4, address: "住所C", shareNum: 2, shareDen: 10 },
    ]);
    expect(plan.get("b")).toEqual([{ position: 2, address: "住所X", shareNum: 3, shareDen: 10 }]);
  });

  it("持分が読めない行・住所が空の行も、行としては残す(持分・住所は null)", () => {
    const plan = planRegistryEntries([{ ownerId: "a", address: "  ", share: null }]);
    expect(plan.get("a")).toEqual([{ position: 1, address: null, shareNum: null, shareDen: null }]);
  });
});

describe("replaceRegistryEntries", () => {
  const makeDb = (links: Array<{ id: string; ownerId: string }>) => ({
    propertyOwner: { findMany: vi.fn(async () => links) },
    propertyOwnerRegistryEntry: { deleteMany: vi.fn(async () => ({})), createMany: vi.fn(async () => ({})) },
  });

  it("取り込みに出てきた所有者の行だけ入れ替える(消してから入れる)", async () => {
    const db = makeDb([{ id: "po-a", ownerId: "a" }]);
    const n = await replaceRegistryEntries(
      db,
      "prop-1",
      [
        { ownerId: "a", address: "住所A", share: "10分の2" },
        { ownerId: "a", address: "住所B", share: "10分の3" },
      ],
      "att-1",
    );
    expect(n).toBe(2);
    expect(db.propertyOwner.findMany).toHaveBeenCalledWith({
      where: { propertyId: "prop-1", ownerId: { in: ["a"] } },
      select: { id: true, ownerId: true },
    });
    expect(db.propertyOwnerRegistryEntry.deleteMany).toHaveBeenCalledWith({
      where: { propertyOwnerId: { in: ["po-a"] } },
    });
    expect(db.propertyOwnerRegistryEntry.createMany).toHaveBeenCalledWith({
      data: [
        { propertyOwnerId: "po-a", position: 1, address: "住所A", shareNum: 2, shareDen: 10, sourceAttachmentId: "att-1" },
        { propertyOwnerId: "po-a", position: 2, address: "住所B", shareNum: 3, shareDen: 10, sourceAttachmentId: "att-1" },
      ],
    });
  });

  it("物件に紐づいていない所有者の行は記録しない(何も消さない)", async () => {
    const db = makeDb([]);
    const n = await replaceRegistryEntries(db, "prop-1", [{ ownerId: "a", address: "住所A", share: null }]);
    expect(n).toBe(0);
    expect(db.propertyOwnerRegistryEntry.deleteMany).not.toHaveBeenCalled();
    expect(db.propertyOwnerRegistryEntry.createMany).not.toHaveBeenCalled();
  });

  it("行が無ければ DB を触らない", async () => {
    const db = makeDb([]);
    expect(await replaceRegistryEntries(db, "prop-1", [])).toBe(0);
    expect(db.propertyOwner.findMany).not.toHaveBeenCalled();
  });
});
