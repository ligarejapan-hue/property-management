/**
 * /admin/owners/correction page.tsx の duplicate グループ表示が
 * duplicateGroupId ベースになっていることの source assertion。
 *
 * テスト環境に React DOM が無いため、source 文字列パターンで担保する。
 *
 * 禁止パターン:
 *   - `c.name ?? "(unknown)"` のような raw 表示値をキー生成に使う
 *   - `c.address ?? "(unknown)"` のような表示値ベースの grouping
 *
 * 要求パターン:
 *   - duplicateGroupId を group key に使う
 *   - duplicateGroupSize（または groups Map の size）を 2 以上で filter
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const file = path.resolve(
  process.cwd(),
  "src/app/(dashboard)/admin/owners/correction/page.tsx",
);
const src = fs.readFileSync(file, "utf8");

describe("correction page: duplicate グループ化キー", () => {
  it("duplicateGroupId を group key に使っている", () => {
    expect(src).toMatch(/duplicateGroupId/);
  });

  it("raw display value (c.name / c.address) ベースの grouping は行わない", () => {
    // `${c.name ?? "(unknown)"}|||${c.address ?? "(unknown)"}` のような
    // 旧パターンが残っていないこと
    expect(src).not.toMatch(/\$\{c\.name\s*\?\?[^}]*\}\|\|\|/);
    expect(src).not.toMatch(/"\(unknown\)"\|\|\|/);
  });

  it("duplicateGroupId !== null の candidate のみグループ化対象", () => {
    expect(src).toMatch(/duplicateGroupId\s*!==?\s*null/);
  });

  it("groupSize >= 2 のグループのみ表示する", () => {
    expect(src).toMatch(/\.length\s*>=\s*2/);
  });
});
