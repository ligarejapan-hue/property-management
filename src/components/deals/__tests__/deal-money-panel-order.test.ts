import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 取引の「金額・費用」タブの並びと見出し(2026-11-03 発注者)。
const src = readFileSync(join(__dirname, "..", "deal-money-panel.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("金額・費用タブの並び", () => {
  it("建物価格と建物消費税の見出しは「業者売主の場合」", () => {
    expect(src).toContain("建物価格と建物消費税(業者売主の場合)");
    expect(src).not.toContain("自社が売主のとき");
  });
  it("仲介手数料は建物消費税の下", () => {
    const building = src.indexOf("建物価格と建物消費税(業者売主の場合)");
    const brokerage = src.indexOf("仲介手数料(上限・税抜)");
    expect(building).toBeGreaterThan(-1);
    expect(brokerage).toBeGreaterThan(building);
    expect(brokerage).toBeGreaterThan(src.indexOf('label="建物消費税"'));
  });
});
