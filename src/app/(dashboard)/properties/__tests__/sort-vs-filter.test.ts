import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 2026-10-25 従業員の指摘⑦「並び替えのボタンと絞り込みのボタンの右端のボタンが同じで分かりづらい」。
// 並び替えは詳細条件(絞り込み)の折りたたみの外に、名前と印つきで置く。絞り込みの「詳細条件」には別の印を付ける。
const src = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\r\n/g, "\n");

/** 詳細条件の折りたたみの中身(`{advancedOpen && (` から、その次の閉じ `)}` の手前の詳細条件の終わりまで)。 */
function advancedBlock(): string {
  const start = src.indexOf("{advancedOpen && (");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("{/* 詳細条件ここまで */}", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("物件一覧: 並び替えと絞り込みを見分けられる", () => {
  it("★並び替えの選択は詳細条件(絞り込み)の折りたたみの中に無い", () => {
    expect(advancedBlock()).not.toContain("value={sort}");
  });

  it("★並び替えは常に見える段にあり、⇅の印と「並び替え」の名前が付く", () => {
    const sortAt = src.indexOf("value={sort}");
    expect(sortAt).toBeGreaterThan(-1);
    expect(sortAt).toBeLessThan(src.indexOf("{advancedOpen && ("));
    const around = src.slice(Math.max(0, sortAt - 900), sortAt);
    expect(around).toContain("<ArrowUpDown");
    expect(around).toContain("並び替え");
  });

  it("★詳細条件(絞り込み)のボタンには絞り込みの印が付く", () => {
    const toggle = src.indexOf("詳細条件{advancedFilterCount");
    expect(toggle).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, toggle - 400), toggle)).toContain("<SlidersHorizontal");
  });

  it("並び替えを変えても「詳細条件(N件適用中)」に数えない(絞り込みではない)", () => {
    const at = src.indexOf("const advancedFilterCount");
    const block = src.slice(at, src.indexOf(";", src.indexOf("(resendOnly ? 1 : 0)", at)) + 1);
    expect(block).not.toContain("sort");
  });
});
