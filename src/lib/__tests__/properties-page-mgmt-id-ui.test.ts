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

  it("統合検索窓の placeholder が管理IDにも触れ、行サフィックスの例を示す", () => {
    // UI一貫性 第1弾(1): 専用窓は廃止し統合窓に。素の数字は地番と曖昧なため
    // 管理ID扱いは「120行」等の明確な構文のみ(placeholder で例示して教える)。
    // R4 で所有者検索を専用の小窓に分離したため、絞り込み窓の placeholder は
    // 住所・地番・管理ID の3用途になった。
    expect(pageSrc).toMatch(/placeholder="住所・地番・管理ID/);
    expect(pageSrc).toMatch(/例: id:120行/);
  });

  it("見分けは共通の純関数 classifyPropertySearch を使う", () => {
    // R6 で toMgmtIdQuery も import するようになったため、名前の存在で見る。
    expect(pageSrc).toContain('from "@/lib/property-search-classify"');
    expect(pageSrc).toContain("classifyPropertySearch");
    expect(pageSrc).toContain("toMgmtIdQuery");
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
