import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "pin-detail-panel.tsx"), "utf-8");

describe("pin-detail-panel: 物件化ボタン配線", () => {
  it("canWriteProperty prop を受け取る", () => {
    expect(src).toMatch(/canWriteProperty\??\s*:/);
  });

  it("candidate かつ propertyId 未設定 かつ open かつ canWriteProperty のときだけ変換可の条件を持つ", () => {
    expect(src).toContain('pinType === "candidate"');
    expect(src).toContain("propertyId == null");
    expect(src).toContain("canWriteProperty === true");
    // canConvert 条件が open のみ(closed/archived を除外)。
    expect(src).toMatch(/canConvert =[\s\S]*?status === "open"[\s\S]*?canWriteProperty/);
  });

  it("ConvertPinToPropertyModal を import・使用し、ボタン文言を持つ", () => {
    expect(src).toContain("ConvertPinToPropertyModal");
    expect(src).toContain("この場所を物件にする");
  });
});
