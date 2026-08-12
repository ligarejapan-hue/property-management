/**
 * 現住所・現住所の郵便番号にも、既存の表示レベル（マスク）が効くことを固定する。
 *
 * 設計: docs/superpowers/specs/2026-08-10-owner-current-address-design.md §5
 *
 * ⚠この確認が要る理由:
 * 表示レベルの適用表(fieldMap)に載っていない項目は **素通りして生の値が返る**(fail-open)。
 * 新しく列を足したときにここへ足し忘れると、住所を「一部表示」や「マスク」に設定して
 * いる利用者に対して、**現住所だけが生のまま見える**。
 *
 * ⚠新しい権限(resource)は作らない。現住所も登記上の住所と同じ機微度なので、
 * `owner_address` / `owner_zip` の設定をそのまま流用する
 * (先例: companyRegistryNumber が corporateNumber の設定を流用している)。
 */
import { describe, it, expect } from "vitest";
import {
  applyDisplayToOwner,
  FIELD_STAFF_OWNER_DISPLAY,
  type OwnerDisplayConfig,
} from "@/lib/display-level";

const OWNER = {
  id: "o1",
  name: "山田太郎",
  zip: "231-0842",
  address: "横浜市南区井土ケ谷中町69-2",
  currentZip: "150-0001",
  currentAddress: "渋谷区神宮前1-1-1",
};

const config = (over: Partial<OwnerDisplayConfig>): OwnerDisplayConfig => ({
  ...FIELD_STAFF_OWNER_DISPLAY,
  ...over,
});

describe("applyDisplayToOwner — 現住所にも表示レベルが効く", () => {
  it("住所が full なら現住所も生の値で返る", () => {
    const out = applyDisplayToOwner(OWNER, config({ address: "full", zip: "full" }));
    expect(out.currentAddress).toBe("渋谷区神宮前1-1-1");
    expect(out.currentZip).toBe("150-0001");
  });

  it("⚠住所が hidden なら現住所も消える（生の値が残らない）", () => {
    const out = applyDisplayToOwner(OWNER, config({ address: "hidden" }));
    expect(out.address).toBeUndefined();
    expect(out.currentAddress).toBeUndefined();
  });

  it("⚠住所が masked なら現住所もマスクされる", () => {
    const out = applyDisplayToOwner(OWNER, config({ address: "masked" }));
    expect(out.currentAddress).not.toBe("渋谷区神宮前1-1-1");
    expect(typeof out.currentAddress).toBe("string");
  });

  it("⚠住所が partial なら現住所も同じ規則で一部表示になる", () => {
    const out = applyDisplayToOwner(OWNER, config({ address: "partial" }));
    // 登記上の住所と同じマスク関数が使われる（別扱いにしない）
    expect(out.currentAddress).not.toBe("渋谷区神宮前1-1-1");
    expect(out.currentAddress).not.toBe(out.address);
  });

  it("⚠郵便番号が hidden なら現住所の郵便番号も消える", () => {
    const out = applyDisplayToOwner(OWNER, config({ zip: "hidden" }));
    expect(out.zip).toBeUndefined();
    expect(out.currentZip).toBeUndefined();
  });

  it("⚠郵便番号が masked なら現住所の郵便番号もマスクされる", () => {
    const out = applyDisplayToOwner(OWNER, config({ zip: "masked" }));
    expect(out.currentZip).not.toBe("150-0001");
    expect(typeof out.currentZip).toBe("string");
  });

  it("現住所が未設定（null）でも壊れない", () => {
    const out = applyDisplayToOwner(
      { ...OWNER, currentZip: null, currentAddress: null },
      config({ address: "partial", zip: "masked" }),
    );
    expect(out.currentAddress).toBeNull();
    expect(out.currentZip).toBeNull();
  });

  it("現地担当の既定（住所=一部表示・郵便番号=マスク）でも現住所が素通りしない", () => {
    const out = applyDisplayToOwner(OWNER, FIELD_STAFF_OWNER_DISPLAY);
    expect(out.currentAddress).not.toBe("渋谷区神宮前1-1-1");
    expect(out.currentZip).not.toBe("150-0001");
  });
});
