/**
 * 棟一覧ページの検索入力 debounce 化のソース表明テスト（F20）。
 *
 * 本プロジェクトの vitest は environment: "node" で jsdom / @testing-library 未導入のため、
 * 既存の properties-page-search-debounce-ui.test.ts と同様にページソースを文字列として検証する。
 * 実挙動（300ms 経過前は未発火・経過後に1回）の保証は debounce.test.ts が
 * vi.useFakeTimers() で担保し、本テストは「配線が崩れていない」ことを固定する。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/(dashboard)/buildings/page.tsx"),
  "utf8",
);

describe("buildings page: 棟一覧検索の debounce 化", () => {
  it("debounce ユーティリティを import している", () => {
    expect(pageSrc).toMatch(
      /import\s*\{\s*debounce\s*\}\s*from\s*"@\/lib\/debounce"/,
    );
  });

  it("入力ドラフト state (keywordDraft) と確定値 (keyword) を分離している", () => {
    expect(pageSrc).toMatch(/const \[keyword, setKeyword\] = useState/);
    expect(pageSrc).toMatch(/const \[keywordDraft, setKeywordDraft\] = useState/);
  });

  it("確定 keyword への反映を 300ms debounce する committer を useMemo で持つ", () => {
    expect(pageSrc).toMatch(/const commitKeyword = useMemo\(/);
    expect(pageSrc).toMatch(
      /debounce\(\(value: string\) => setKeyword\(value\), 300\)/,
    );
  });

  it("アンマウント時に保留中の debounce を cancel する", () => {
    expect(pageSrc).toMatch(/commitKeyword\.cancel\(\)/);
  });

  it("検索入力欄はドラフト値を表示し、onChange はドラフト更新＋debounce コミットのみ", () => {
    expect(pageSrc).toMatch(/value=\{keywordDraft\}/);
    expect(pageSrc).toMatch(/setKeywordDraft\(value\);\s*commitKeyword\(value\)/);
    // 旧来の「入力 onChange で確定値を即時 setKeyword」する配線は排除する。
    expect(pageSrc).not.toMatch(/onChange=\{\(e\) => setKeyword\(e\.target\.value\)\}/);
  });

  it("fetch (load) は確定値 keyword を使い、draft を直接流さない", () => {
    expect(pageSrc).toMatch(/fetchBuildings\(keyword \|\| undefined\)/);
    expect(pageSrc).not.toMatch(/fetchBuildings\(keywordDraft/);
    // load の依存は確定値 keyword（draft では再 fetch しない）。
    expect(pageSrc).toMatch(/\}, \[keyword\]\);/);
  });
});
