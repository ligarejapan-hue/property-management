import { describe, it, expect, vi } from "vitest";
import {
  renamePropagateConfirmMessage,
  isBuildingRename,
  countEditLockedUnits,
  propagateBuildingName,
  lockBuildingUnits,
  unitsOutsideScope,
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
  const U = (id: string, buildingName: string | null) => ({ id, buildingName, createdBy: "c", assignedTo: null });
  function makeTx() {
    return { property: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) } };
  }
  it("渡された行のうち物件名が違う部屋と null の部屋だけを、その id で直し、版番号を進め、変更履歴を返す", async () => {
    const tx = makeTx();
    const r = await propagateBuildingName(tx as never, {
      units: [U("p1", "旧"), U("p2", null), U("p3", "新")],
      newName: "新",
      userId: "u1",
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
    const tx = makeTx();
    const r = await propagateBuildingName(tx as never, { units: [U("p3", "新")], newName: "新", userId: "u1" });
    expect(r).toEqual({ updated: 0, changeLogs: [] });
    expect(tx.property.updateMany).not.toHaveBeenCalled();
  });
});

describe("lockBuildingUnits / unitsOutsideScope", () => {
  it("部屋の行を id 順に FOR UPDATE で読む", async () => {
    const rows = [{ id: "p1", buildingName: null, createdBy: "c", assignedTo: null }];
    const tx = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    expect(await lockBuildingUnits(tx as never, "b1")).toBe(rows);
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/ORDER BY "id"/);
    expect(sql).toMatch(/"building_id" = \?::uuid/);
    expect(sql).toMatch(/"created_by" AS "createdBy"/);
    expect(sql).toMatch(/"assigned_to" AS "assignedTo"/);
  });
  const units = [
    { id: "own", buildingName: "x", createdBy: "u1", assignedTo: null },
    { id: "assigned", buildingName: "x", createdBy: "z", assignedTo: "u1" },
    { id: "other", buildingName: "x", createdBy: "z", assignedTo: null },
    { id: "other2", buildingName: "x", createdBy: "z", assignedTo: "y" },
  ];
  it("field_staff は作成者でも担当でもない部屋(担当 null を含む)が担当外", () => {
    expect(unitsOutsideScope(units, { id: "u1", role: "field_staff" }).map((u) => u.id)).toEqual(["other", "other2"]);
  });
  it("field_staff 以外は担当外が無い", () => {
    expect(unitsOutsideScope(units, { id: "u1", role: "office_staff" })).toEqual([]);
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
