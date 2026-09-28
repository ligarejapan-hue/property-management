/**
 * 物件の詳細画面: 棟に紐づいていない区分は、棟の5項目(構造・地上階・地下階・総戸数・
 * 築年月)を物件そのものの欄から表示する(unit-building-facts.ts)。以前はどこにも
 * 出ていなかった(本番の区分は全件が棟なし・2026-09-27 実測)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("物件の詳細画面 — 棟が無い区分の棟の項目", () => {
  const start = src.indexOf("{isUnit && (\n        <>");
  const block = src.slice(start, src.indexOf("</>", start));

  it("区分の表示ブロックの中で、棟が無いときだけ出す", () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toContain("{!property.building && (");
  });

  it.each([
    ["構造", "property.structureType"],
    ["地上階", "property.aboveFloors"],
    ["地下階", "property.basementFloors"],
    ["総戸数", "property.totalUnits"],
  ])("「%s」を物件の欄(%s)から出す", (label, expr) => {
    expect(block).toContain(`label="${label}"`);
    expect(block).toContain(expr);
  });

  it("築年月は共通の表示関数で年・月を組み立てる(「2020年—月」を出さない)", () => {
    expect(block).toContain('label="築年月"');
    expect(block).toContain("formatBuiltYearMonth(property.builtYear, property.builtMonth)");
  });
});
