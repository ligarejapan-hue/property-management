/**
 * 物件の詳細画面: 区分マンションの棟の5項目(構造・地上階・地下階・総戸数・築年月)を出す。
 *
 * - 棟に紐づいていない区分は、物件そのものの欄から(2026-09-27)。
 * - 棟に紐づいた区分でも出す。棟の値が正で、棟の欄が空のときだけ物件の欄の値(2026-11-15 発注者決定=案3)。
 *   前は棟に紐づいた区分では出しておらず、物件名と一緒に入れた値が棟ができた瞬間に見えなくなっていた。
 * どこから読むかの判断は unit-building-facts.ts の1か所(図面・編集画面と同じ)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(process.cwd(), "src/app/(dashboard)/properties/[id]/page.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("物件の詳細画面 — 区分の棟の項目", () => {
  const start = src.indexOf("{isUnit && (\n        <>");
  const end = src.indexOf("{/* 戸建・土地・一棟の土地面積・建物面積", start);
  const block = src.slice(start, end);

  it("区分の表示ブロックの中で、棟の有無に関わらず出す(棟が無いときだけ、の条件を付けない)", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(block).not.toContain("{!property.building && (");
  });

  it("★読む場所の判断は unitBuildingFacts に任せる(画面で棟か物件かを選ばない)", () => {
    expect(block).toContain("const facts = unitBuildingFacts(property, property.building);");
    expect(src).toContain('import { unitBuildingFacts } from "@/lib/sales-sheet/unit-building-facts";');
  });

  it.each([
    ["構造", "facts.structureType"],
    ["地上階", "facts.totalFloors"],
    ["地下階", "facts.basementFloors"],
    ["総戸数", "facts.totalUnits"],
  ])("「%s」を %s から出す", (label, expr) => {
    expect(block).toContain(`label="${label}"`);
    expect(block).toContain(expr);
  });

  it("築年月は共通の表示関数で年・月を組み立てる(「2020年—月」を出さない)", () => {
    expect(block).toContain('label="築年月"');
    expect(block).toContain("formatBuiltYearMonth(facts.builtYear, facts.builtMonth)");
  });
});
