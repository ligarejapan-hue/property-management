import { describe, it, expect } from "vitest";
import { salesSheetTemplateKindFor } from "../template-kind";

describe("salesSheetTemplateKindFor", () => {
  it.each([
    ["land", "land"],
    ["apartment_unit", "mansion"],
    ["unit", "mansion"], // 区分（旧）: 棟画面から作成した区分は legacy "unit" で保存される
    ["house", "house"],
    ["apartment_building", "building"],
    ["apartment_block", "building"],
  ] as const)("%s → %s", (propertyType, kind) => {
    expect(salesSheetTemplateKindFor(propertyType)).toBe(kind);
  });

  // 対応テンプレの無い種別と、曖昧な legacy "building"（建物・旧）は null（作成導線を出さない）。
  it.each(["store", "office", "warehouse", "parking", "unknown", "building"])(
    "対応外/曖昧な %s は null",
    (propertyType) => {
      expect(salesSheetTemplateKindFor(propertyType)).toBeNull();
    },
  );
});
