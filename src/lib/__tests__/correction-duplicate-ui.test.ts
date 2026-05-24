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

// Phase 2-A: duplicate サブフィルタ
describe("correction page: Phase 2-A duplicate サブフィルタ", () => {
  it("DuplicateSubFilterBar コンポーネントが存在する", () => {
    expect(src).toMatch(/function DuplicateSubFilterBar/);
  });

  it("サブフィルタ enum (all / name_address / corporate_number / external_link_key) が定義されている", () => {
    expect(src).toMatch(/type DuplicateSubFilter/);
    expect(src).toMatch(/"name_address"/);
    expect(src).toMatch(/"corporate_number"/);
    expect(src).toMatch(/"external_link_key"/);
  });

  it("4 つのサブフィルタラベル（すべて / 氏名住所一致 / 法人番号一致 / リンクキー一致）が存在する", () => {
    expect(src).toMatch(/すべて/);
    expect(src).toMatch(/氏名住所一致/);
    expect(src).toMatch(/法人番号一致/);
    expect(src).toMatch(/リンクキー一致/);
  });

  it("duplicateMatchedBy で client-side フィルタしている", () => {
    expect(src).toMatch(/duplicateMatchedBy\s*===\s*duplicateSubFilter/);
  });

  it("サブフィルタ state とハンドラが定義されている", () => {
    expect(src).toMatch(/duplicateSubFilter/);
    expect(src).toMatch(/setDuplicateSubFilter/);
  });
});
