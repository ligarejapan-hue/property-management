/**
 * 物件一覧ページの検索入力 (keyword / 管理ID) debounce 化のソース表明テスト。
 *
 * 本プロジェクトの vitest は environment: "node" で jsdom / @testing-library 未導入のため、
 * 既存の properties-page-mgmt-id-ui.test.ts と同様にページソースを文字列として検証する。
 * 実挙動（300ms 経過前は未発火・経過後に1回）の保証は debounce.test.ts が
 * vi.useFakeTimers() で担保し、本テストは「配線が崩れていない」ことを固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/properties/page.tsx"),
  "utf8",
);

describe("properties page: 一覧検索 (keyword/管理ID) の debounce 化", () => {
  it("debounce ユーティリティを import している", () => {
    expect(pageSrc).toMatch(/import\s*\{\s*debounce\s*\}\s*from\s*"@\/lib\/debounce"/);
  });

  it("統合ドラフト state (searchAllDraft) を URL 復元値(keyword優先)で初期化する", () => {
    // UI一貫性 第1弾(1): 検索窓を1本に統合した(旧: searchDraft / mgmtIdDraft の2本)。
    expect(pageSrc).toMatch(
      /const \[searchAllDraft, setSearchAllDraft\] = useState\(/,
    );
    expect(pageSrc).toMatch(/sp\.get\("keyword"\) \|\| sp\.get\("mgmtId"\)/);
  });

  it("keyword / 管理ID の確定コミットを 300ms debounce する committer を持つ", () => {
    expect(pageSrc).toMatch(/const commitKeyword = useMemo\(/);
    expect(pageSrc).toMatch(/const commitMgmtId = useMemo\(/);
    // 確定値 (searchText/mgmtIdText) へは debounce(…, 300) 経由でのみ反映する
    expect(pageSrc).toMatch(
      /debounce\(\(value: string\) => \{\s*setSearchText\(value\);\s*setPage\(1\);\s*\}, 300\)/,
    );
    expect(pageSrc).toMatch(
      /debounce\(\(value: string\) => \{\s*setMgmtIdText\(value\);\s*setPage\(1\);\s*\}, 300\)/,
    );
  });

  it("統合検索欄はドラフト値を表示し、onChange は見分け(classify)経由でコミットする", () => {
    expect(pageSrc).toMatch(/value=\{searchAllDraft\}/);
    expect(pageSrc).toMatch(/handleUnifiedSearchChange\(e\.target\.value\)/);
    // 見分けの結果で片方へ流し、もう片方は必ず空にする(古い絞り込みを残さない)。
    expect(pageSrc).toMatch(/classifyPropertySearch\(value\)/);
    expect(pageSrc).toMatch(/commitKeyword\(""\)/);
    expect(pageSrc).toMatch(/commitMgmtId\(""\)/);
  });

  it("入力 onChange からの確定値への即時反映 (handleFilterChange(setSearchText/setMgmtIdText)) を排除している", () => {
    expect(pageSrc).not.toMatch(/handleFilterChange\(setSearchText\)/);
    expect(pageSrc).not.toMatch(/handleFilterChange\(setMgmtIdText\)/);
  });

  it("API・URL同期は確定値 (searchText/mgmtIdText) を使い、draft を直接流さない", () => {
    expect(pageSrc).toMatch(/params\.keyword = searchText/);
    expect(pageSrc).toMatch(/params\.mgmtId = mgmtIdText/);
    expect(pageSrc).toMatch(/params\.set\("keyword", searchText\)/);
    expect(pageSrc).toMatch(/params\.set\("mgmtId", mgmtIdText\)/);
    expect(pageSrc).not.toMatch(/params\.keyword = searchDraft/);
    expect(pageSrc).not.toMatch(/params\.set\("keyword", searchDraft\)/);
  });

  it("リセットでドラフトを空にし、保留中の debounce を cancel する", () => {
    expect(pageSrc).toMatch(/setSearchAllDraft\(""\)/);
    expect(pageSrc).toMatch(/commitKeyword\.cancel\(\)/);
    expect(pageSrc).toMatch(/commitMgmtId\.cancel\(\)/);
  });

  it("アンマウント時に debounce を cancel する cleanup を持つ", () => {
    expect(pageSrc).toMatch(/commitKeyword\.cancel\(\);\s*commitMgmtId\.cancel\(\)/);
  });
});
