/**
 * 物件一覧ページの管理ID 検索欄 / URL sync / reset の source assertion。
 *
 * - 管理ID 検索欄 (mgmtIdText) の追加
 * - placeholder 文言
 * - URL params 同期 / fetchProperties 引数同期
 * - リセットで mgmtId も消える
 * - 既存の管理ID列再表示が起きていない
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);

describe("properties page: 管理ID 検索欄", () => {
  it("mgmtIdText state を持つ", () => {
    expect(pageSrc).toMatch(/setMgmtIdText/);
    expect(pageSrc).toMatch(/sp\.get\("mgmtId"\)/);
  });

  it("placeholder「管理IDで検索」を含む input がある", () => {
    expect(pageSrc).toMatch(/placeholder="管理IDで検索/);
  });

  it("placeholder に例（受付帳 / 行）が含まれる", () => {
    expect(pageSrc).toMatch(/受付帳.*xlsx/);
    expect(pageSrc).toMatch(/120行/);
  });

  it("fetchProperties で mgmtId クエリを送る", () => {
    expect(pageSrc).toMatch(/params\.mgmtId\s*=\s*mgmtIdText/);
  });

  it("URL query に mgmtId を sync する", () => {
    expect(pageSrc).toMatch(/params\.set\("mgmtId"/);
  });

  it("リセットで mgmtIdText を空にする", () => {
    expect(pageSrc).toMatch(/setMgmtIdText\(""\)/);
  });

  it("hasActiveFilter で mgmtIdText を判定対象に含める", () => {
    expect(pageSrc).toMatch(/!!mgmtIdText/);
  });

  it("table thead に「管理ID」列ヘッダが新規追加されていない（再表示禁止維持）", () => {
    // th 内のテキストとしての「管理ID」が無いことを確認
    expect(pageSrc).not.toMatch(/<th[^>]*>\s*管理ID/);
  });
});
