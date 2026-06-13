import { describe, it, expect } from "vitest";
import { decideOwnerCorporateCleanup } from "../corporate-number-cleanup";

const N = "1234567890123";
const M = "9876543210987";

describe("decideOwnerCorporateCleanup", () => {
  it("検出なし → action none", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
  });

  it("列空・name に1候補 → cleanup・列へ移送・name除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("save");
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name", "corporateNumber"]);
  });

  it("列=候補と同一・text にも混入 → cleanup・移送なし・text除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: N });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("noop");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("列=別番号・text に別番号混入(conflict)→ cleanup・移送なし・検出番号のみ除去", () => {
    const p = decideOwnerCorporateCleanup({ name: `株式会社○○ ${N}`, address: null, note: null, corporateNumber: M });
    expect(p.action).toBe("cleanup");
    expect(p.importAction).toBe("conflict");
    expect(p.corporateNumberToSet).toBeNull();
    expect(p.cleanedName).toBe("株式会社○○");
    expect(p.changedFields).toEqual(["name"]);
  });

  it("複数番号検出 → manual(multi)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: `${N} ${M}`, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("multi");
    expect(p.changedFields).toEqual([]);
  });

  it("空化ガード: name が番号のみ → manual(name_would_be_empty)・変更なし", () => {
    const p = decideOwnerCorporateCleanup({ name: N, address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("manual");
    expect(p.manualReason).toBe("name_would_be_empty");
    expect(p.changedFields).toEqual([]);
  });

  it("address に混入 → address除去・空になれば null 化", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: N, note: null, corporateNumber: null });
    expect(p.action).toBe("cleanup");
    expect(p.cleanedAddress).toBeNull();
    expect(p.corporateNumberToSet).toBe(N);
    expect(p.changedFields).toEqual(["address", "corporateNumber"]);
  });

  it("raw-visible でないフィールドは呼び出し側で null を渡す前提(全フィールド null → none)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: null });
    expect(p.action).toBe("none");
  });

  it("idempotency: cleanup済(name清浄＋列に番号)を再投入 → action none・changedFields空(二重更新しない)", () => {
    const p = decideOwnerCorporateCleanup({ name: "株式会社○○", address: null, note: null, corporateNumber: N });
    expect(p.action).toBe("none");
    expect(p.changedFields).toEqual([]);
    expect(p.corporateNumberToSet).toBeNull();
  });
});
