/**
 * 21-C PR-1 (Codex P2): Building の postalCode 編集が ChangeLog に記録されること。
 * Building PATCH は postalCode を永続化する以上、他の building 項目と同様に
 * field-level ChangeLog にも残す（監査一貫性）。
 *  - BUILDING_TRACKED_FIELDS に postalCode を含む
 *  - recordChanges が postalCode の変更/クリアを ChangeLog エントリ化する
 *  - 既存 tracked fields の挙動は不変
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: { changeLog: { createMany: vi.fn() } },
}));

import prisma from "@/lib/prisma";
import { recordChanges, BUILDING_TRACKED_FIELDS } from "@/lib/change-log";

const pm = prisma as unknown as { changeLog: { createMany: Mock } };

function entriesFromLastCall(): Array<Record<string, unknown>> {
  const call = pm.changeLog.createMany.mock.calls.at(-1);
  return (call?.[0]?.data ?? []) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // recordChanges は NEXT_PUBLIC_USE_MOCK==="true" で early return するため明示的に無効化。
  vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "false");
  pm.changeLog.createMany.mockResolvedValue({ count: 1 });
});

describe("BUILDING_TRACKED_FIELDS に postalCode（21-C PR-1 Codex P2）", () => {
  it("postalCode を含む", () => {
    expect(BUILDING_TRACKED_FIELDS).toContain("postalCode");
  });

  it("既存の tracked fields は維持（name/address/note 等）", () => {
    for (const f of ["name", "address", "note", "totalFloors"]) {
      expect(BUILDING_TRACKED_FIELDS).toContain(f);
    }
  });
});

describe("recordChanges: building postalCode の記録（21-C PR-1 Codex P2）", () => {
  it("postalCode を新規設定したら ChangeLog エントリを作る", async () => {
    await recordChanges({
      targetTable: "buildings",
      targetId: "b1",
      changedBy: "u1",
      oldValues: { postalCode: null, address: "東京" },
      newValues: { postalCode: "1050001" },
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "manual",
    });
    const entries = entriesFromLastCall();
    const pc = entries.find((e) => e.fieldName === "postalCode");
    expect(pc).toBeTruthy();
    expect(pc?.oldValue).toBeNull();
    expect(pc?.newValue).toBe("1050001");
  });

  it("postalCode を null にクリアしたら old→null の ChangeLog エントリを作る", async () => {
    await recordChanges({
      targetTable: "buildings",
      targetId: "b1",
      changedBy: "u1",
      oldValues: { postalCode: "1050001" },
      newValues: { postalCode: null },
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "manual",
    });
    const entries = entriesFromLastCall();
    const pc = entries.find((e) => e.fieldName === "postalCode");
    expect(pc).toBeTruthy();
    expect(pc?.oldValue).toBe("1050001");
    expect(pc?.newValue).toBeNull();
  });

  it("postalCode が未変更（同値）なら ChangeLog に出さない（非退行）", async () => {
    await recordChanges({
      targetTable: "buildings",
      targetId: "b1",
      changedBy: "u1",
      oldValues: { postalCode: "1050001", address: "東京" },
      newValues: { address: "東京" }, // postalCode を送っていない
      trackedFields: BUILDING_TRACKED_FIELDS,
      source: "manual",
    });
    const entries = entriesFromLastCall();
    expect(entries.find((e) => e.fieldName === "postalCode")).toBeFalsy();
  });
});
