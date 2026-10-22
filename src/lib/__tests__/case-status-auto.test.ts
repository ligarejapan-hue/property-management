import { describe, it, expect, vi } from "vitest";
import { CASE_STATUS_VALUES } from "../property-types";
import { autoAdvanceCaseStatus, canAutoAdvanceCaseStatus, type AutoCaseStatusTx } from "../case-status-auto";

describe("canAutoAdvanceCaseStatus(前に進むときだけ)", () => {
  it.each(CASE_STATUS_VALUES)("所有者とやりとり中へ: いまが %s", (v) => {
    expect(canAutoAdvanceCaseStatus(v, "contacting_owner")).toBe(v === "new_case" || v === "contact_attempting");
  });

  it.each(CASE_STATUS_VALUES)("査定中へ: いまが %s", (v) => {
    expect(canAutoAdvanceCaseStatus(v, "appraisal")).toBe(v === "new_case" || v === "contact_attempting" || v === "contacting_owner");
  });

  it.each(["hold", "closed", "other_brokerage", "negotiating", "sold"])("%s は自動では動かさない", (v) => {
    expect(canAutoAdvanceCaseStatus(v, "contacting_owner")).toBe(false);
    expect(canAutoAdvanceCaseStatus(v, "appraisal")).toBe(false);
  });

  // 反映の直後(移し直しの前)に旧版が書いたやめた値が残っていても、移し先と同じに扱う
  // =自動の切り替えを取りこぼさない(@codex #538 R6 P2)。
  it.each([
    ["dm_sent", "contacting_owner", true],
    ["dm_target", "contacting_owner", true],
    ["site_checked", "contacting_owner", false],
    ["owner_contacted", "appraisal", true],
    ["response_received", "appraisal", true],
    ["waiting_registry", "appraisal", true],
    ["done", "contacting_owner", false],
    ["done", "appraisal", false],
  ] as const)("やめた値 %s → %s: %s(移し先の値で判断)", (from, to, ok) => {
    expect(canAutoAdvanceCaseStatus(from, to)).toBe(ok);
  });
});

function fakeTx(current: string | null, updatedCount = 1) {
  const tx = {
    property: {
      findUnique: vi.fn(async () => (current === null ? null : { caseStatus: current })),
      updateMany: vi.fn(async () => ({ count: updatedCount })),
    },
    changeLog: { create: vi.fn(async () => ({})) },
  };
  return tx as typeof tx & AutoCaseStatusTx;
}

describe("autoAdvanceCaseStatus", () => {
  it("未着手 → 所有者とやりとり中: 条件付きで書き(版は上げない=編集中の人の保存を断らせない)、履歴に「自動」で残す", async () => {
    const tx = fakeTx("new_case");
    const done = await autoAdvanceCaseStatus(tx, { propertyId: "p1", to: "contacting_owner", changedBy: "u1" });
    expect(done).toBe(true);
    expect(tx.property.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", caseStatus: "new_case" },
      data: { caseStatus: "contacting_owner" },
    });
    expect(tx.changeLog.create).toHaveBeenCalledWith({
      data: {
        targetTable: "properties", targetId: "p1", fieldName: "caseStatus",
        oldValue: "new_case", newValue: "contacting_owner", source: "auto", changedBy: "u1",
      },
    });
  });

  it("商談中の物件は、査定報告書が付いても戻さない(書かない・履歴も残さない)", async () => {
    const tx = fakeTx("negotiating");
    expect(await autoAdvanceCaseStatus(tx, { propertyId: "p1", to: "appraisal", changedBy: "u1" })).toBe(false);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("読んだあとに人が変えていた(条件付き書き込みが0件)なら、履歴を残さない", async () => {
    const tx = fakeTx("new_case", 0);
    expect(await autoAdvanceCaseStatus(tx, { propertyId: "p1", to: "contacting_owner", changedBy: "u1" })).toBe(false);
    expect(tx.changeLog.create).not.toHaveBeenCalled();
  });

  it("物件が無ければ何もしない", async () => {
    const tx = fakeTx(null);
    expect(await autoAdvanceCaseStatus(tx, { propertyId: "p1", to: "contacting_owner", changedBy: "u1" })).toBe(false);
    expect(tx.property.updateMany).not.toHaveBeenCalled();
  });
});
