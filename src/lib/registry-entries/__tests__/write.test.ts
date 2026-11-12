import { describe, it, expect, vi } from "vitest";
import {
  assignRegistryRowsToOwners,
  moveRegistryEntriesToLink,
  planRegistryEntries,
  replaceRegistryEntries,
} from "@/lib/registry-entries/write";
import { ownerNameKey } from "@/lib/registry-owner-check/compare";

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

describe("moveRegistryEntriesToLink(所有者の統合で、消えるつながりの行を残る側へ引き継ぐ・@codex #714 P2)", () => {
  const makeDb = (from: Array<{ id: string; position: number }>, toLast: Array<{ id: string; position: number }>) => ({
    propertyOwnerRegistryEntry: {
      findMany: vi.fn(async (args: { where: { propertyOwnerId: string } }) =>
        args.where.propertyOwnerId === "from" ? from : toLast,
      ),
      update: vi.fn(async (_args: { where: { id: string }; data: { propertyOwnerId: string; position: number } }) => ({})),
    },
  });

  it("残る側に行が無ければ、順番を保って 1 から引き継ぐ", async () => {
    const db = makeDb(
      [
        { id: "e1", position: 2 },
        { id: "e2", position: 5 },
      ],
      [],
    );
    expect(await moveRegistryEntriesToLink(db, "from", "to")).toBe(2);
    expect(db.propertyOwnerRegistryEntry.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "e1" }, data: { propertyOwnerId: "to", position: 1 } },
      { where: { id: "e2" }, data: { propertyOwnerId: "to", position: 2 } },
    ]);
  });

  it("残る側に行があれば、その後ろに足す(番号がぶつからない)", async () => {
    const db = makeDb([{ id: "e1", position: 1 }], [{ id: "m9", position: 3 }]);
    await moveRegistryEntriesToLink(db, "from", "to");
    expect(db.propertyOwnerRegistryEntry.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { propertyOwnerId: "to", position: 4 },
    });
  });

  it("消える側に行が無ければ何もしない", async () => {
    const db = makeDb([], [{ id: "m9", position: 3 }]);
    expect(await moveRegistryEntriesToLink(db, "from", "to")).toBe(0);
    expect(db.propertyOwnerRegistryEntry.update).not.toHaveBeenCalled();
  });
});

describe("assignRegistryRowsToOwners(所有者事項の行を、物件につながっている所有者に当てる・第2回)", () => {
  const linked = [
    { ownerId: "taro", name: "山田太郎", isArchived: false },
    { ownerId: "takahashi", name: "髙橋一郎", isArchived: false },
    { ownerId: "old", name: "鈴木一郎", isArchived: true },
  ];

  it("名前が同じ人に当てる(空白・異体字はそろえる・住所では当てない)", () => {
    expect(
      assignRegistryRowsToOwners(
        [
          { name: "山田太郎", address: "住所A", share: "10分の2" },
          { name: "高橋一郎", address: "住所X", share: "10分の3" },
          { name: "山田　太郎", address: "住所B", share: "10分の5" },
        ],
        linked,
      ),
    ).toEqual([
      { ownerId: "taro", address: "住所A", share: "10分の2" },
      { ownerId: "takahashi", address: "住所X", share: "10分の3" },
      { ownerId: "taro", address: "住所B", share: "10分の5" },
    ]);
  });

  it("つながっていない人・保管した人の行は捨てる", () => {
    expect(
      assignRegistryRowsToOwners(
        [
          { name: "田中花子", address: "住所Z", share: null },
          { name: "鈴木一郎", address: "住所Y", share: null },
        ],
        linked,
      ),
    ).toEqual([]);
  });

  it("⚠名前のそろえ方を渡したら、そのそろえ方で当てる(名義の確認と同じ決め方にするため)", () => {
    // 名義の確認は (株) と 株式会社 を同じ人にする。当てる側が別人として捨てると、
    // 「試し終えた」印だけ付いて二度と記録されない(内部レビュー P2)。
    const corp = [{ ownerId: "c1", name: "(株)見本商事", isArchived: false }];
    const rows = [{ name: "株式会社見本商事", address: "住所C", share: "2分の1" }];
    expect(assignRegistryRowsToOwners(rows, corp)).toEqual([]);
    expect(assignRegistryRowsToOwners(rows, corp, ownerNameKey)).toEqual([
      { ownerId: "c1", address: "住所C", share: "2分の1" },
    ]);
  });

  it("そろえた名前が空の行・保管した人には当てない", () => {
    const key = (s: string) => s.trim();
    expect(
      assignRegistryRowsToOwners(
        [
          { name: "  ", address: "住所A", share: null },
          { name: "鈴木一郎", address: "住所B", share: null },
        ],
        [
          { ownerId: "empty", name: "", isArchived: false },
          { ownerId: "old", name: "鈴木一郎", isArchived: true },
        ],
        key,
      ),
    ).toEqual([]);
  });
});
