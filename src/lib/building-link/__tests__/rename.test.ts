import { describe, it, expect, vi } from "vitest";
import {
  renamePropagateConfirmMessage,
  isBuildingRename,
  countEditLockedUnits,
  propagateBuildingName,
  countUnitsOutsideScope,
} from "@/lib/building-link/rename";
import { lockBuildingRow, lockBuildingRowNoKeyUpdate } from "@/lib/edit-lock/row-locks";

describe("rename", () => {
  it("部屋があるときだけ確認する", () => {
    expect(renamePropagateConfirmMessage("旧", "新", 3)).toBe("部屋3件の物件名も「新」に直します。よろしいですか？");
    expect(renamePropagateConfirmMessage("旧", "新", 0)).toBeNull();
    expect(renamePropagateConfirmMessage("同じ", " 同じ ", 3)).toBeNull();
  });
  it("前後の空白だけの違いは名前の変更ではない", () => {
    expect(isBuildingRename("A", " A ")).toBe(false);
    expect(isBuildingRename("A", undefined)).toBe(false);
    expect(isBuildingRename("A", "B")).toBe(true);
  });
  it("編集中の鍵の数え方: 解除されておらず、合図と操作が期限内のものだけ(DB の時計で)", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ n: 2 }]) };
    expect(await countEditLockedUnits(tx as never, "b1")).toBe(2);
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/"force_released_at" IS NULL/);
    expect(sql).toMatch(/clock_timestamp\(\)/);
    expect(sql).toMatch(/"building_id" = \?::uuid/);
  });
  it("行が返らなければ0件", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    expect(await countEditLockedUnits(tx as never, "b1")).toBe(0);
  });
});

describe("propagateBuildingName", () => {
  function makeTx(units: { id: string; buildingName: string | null }[]) {
    return {
      property: {
        findMany: vi.fn().mockResolvedValue(units),
        updateMany: vi.fn().mockResolvedValue({ count: units.length }),
      },
    };
  }
  it("物件名が違う部屋と null の部屋を直し、版番号を進め、変更履歴を返す", async () => {
    const tx = makeTx([
      { id: "p1", buildingName: "旧" },
      { id: "p2", buildingName: null },
    ]);
    const r = await propagateBuildingName(tx as never, { buildingId: "b1", newName: "新", userId: "u1" });
    const arg = tx.property.findMany.mock.calls[0][0] as { where: unknown };
    // null の部屋を拾う条件(SQL の <> は NULL を除くため OR で明示)
    expect(arg.where).toEqual({
      buildingId: "b1",
      OR: [{ buildingName: null }, { NOT: { buildingName: "新" } }],
    });
    expect(tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p2"] } },
      data: { buildingName: "新", version: { increment: 1 } },
    });
    expect(r.updated).toBe(2);
    expect(r.changeLogs).toEqual([
      { targetTable: "properties", targetId: "p1", fieldName: "buildingName", oldValue: "旧", newValue: "新", source: "manual", changedBy: "u1" },
      { targetTable: "properties", targetId: "p2", fieldName: "buildingName", oldValue: null, newValue: "新", source: "manual", changedBy: "u1" },
    ]);
  });
  it("直す部屋が無ければ書かない", async () => {
    const tx = makeTx([]);
    const r = await propagateBuildingName(tx as never, { buildingId: "b1", newName: "新", userId: "u1" });
    expect(r).toEqual({ updated: 0, changeLogs: [] });
    expect(tx.property.updateMany).not.toHaveBeenCalled();
  });
});

describe("棟の行ロック", () => {
  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");
  it("名前の反映用は FOR NO KEY UPDATE(物件保存の外部キー FOR KEY SHARE とぶつからない)", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await lockBuildingRowNoKeyUpdate(tx as never, "b1");
    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toMatch(/FOR NO KEY UPDATE/);
  });
  it("既存の lockBuildingRow は FOR UPDATE のまま", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await lockBuildingRow(tx as never, "b1");
    const sql = sqlOf(tx.$queryRaw.mock.calls[0]);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/NO KEY/);
  });
});

describe("countUnitsOutsideScope", () => {
  it("作成者でも担当でもない部屋を数える(担当が null の部屋も含む)", async () => {
    const tx = { property: { count: vi.fn().mockResolvedValue(3) } };
    expect(await countUnitsOutsideScope(tx as never, "b1", "u1")).toBe(3);
    expect(tx.property.count).toHaveBeenCalledWith({
      where: {
        buildingId: "b1",
        createdBy: { not: "u1" },
        OR: [{ assignedTo: null }, { assignedTo: { not: "u1" } }],
      },
    });
  });
});
