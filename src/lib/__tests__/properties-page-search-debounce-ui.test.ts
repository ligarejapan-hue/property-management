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

  it("統合検索欄はドラフト値を表示し、onChange は見分け(classify)経由で処理する", () => {
    expect(pageSrc).toMatch(/value=\{searchAllDraft\}/);
    expect(pageSrc).toMatch(/handleUnifiedSearchChange\(e\.target\.value\)/);
    expect(pageSrc).toMatch(/classifyPropertySearch\(value\)/);
    expect(pageSrc).toMatch(/commitKeyword\(""\)/);
    expect(pageSrc).toMatch(/commitMgmtId\(""\)/);
  });

  it("⚠text 入力を keyword に自動コミットしない(所有者PIIをURL/監査に載せない・@codex #404 R1 P1)", () => {
    // 入力中に流してよいのは suggest(POST) と mgmtId(非PII構文)だけ。
    // keyword の確定は Enter(handleUnifiedSearchSubmit)の明示操作のみ。
    // ⚠onChange ハンドラ内の commitKeyword は**全て空文字**であること。
    //   /commitKeyword\(value\)/ の不在だけでは、三項演算子
    //   (commitKeyword(kind === "text" ? value : "")) の形で漏れが再発しても
    //   捕まえられない(変異実測ですり抜けた)。
    const hAt = pageSrc.indexOf("const handleUnifiedSearchChange");
    const hEnd = pageSrc.indexOf("const handleUnifiedSearchSubmit");
    expect(hAt).toBeGreaterThan(-1);
    expect(hEnd).toBeGreaterThan(hAt);
    const handler = pageSrc.slice(hAt, hEnd);
    const commits = handler.match(/commitKeyword\([^)]*\)/g) ?? [];
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      expect(c).toBe('commitKeyword("")');
    }
    expect(pageSrc).toMatch(/handleUnifiedSearchSubmit/);
    // Enter 側でだけ確定する(直接 setSearchText)。
    const at = pageSrc.indexOf("const handleUnifiedSearchSubmit");
    expect(at).toBeGreaterThan(-1);
    const body = pageSrc.slice(at, at + 700);
    expect(body).toContain("setSearchText(value)");
    expect(body).toContain('classifyPropertySearch(value) !== "text"');
  });

  it("⚠旧ブックマーク(keyword+mgmtId両方)は見える方(keyword)だけ復元する(@codex #404 R1 P2)", () => {
    expect(pageSrc).toMatch(
      /sp\.get\("keyword"\) \? "" : \(sp\.get\("mgmtId"\) \?\? ""\)/,
    );
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

describe("候補優先のEnter(@codex #404 R2 P1/P2)", () => {
  it("候補が出ている間の Enter は候補を開き、keyword を確定しない", () => {
    // 所有者検索は suggest(POST) 経由で完結=PII が URL/監査へ落ちない。
    const at = pageSrc.indexOf('if (e.key === "Enter")');
    expect(at).toBeGreaterThan(-1);
    const branch = pageSrc.slice(at, at + 700);
    expect(branch).toContain("suggestOpen && suggestResults.length > 0");
    expect(branch).toMatch(/router\.push\(`\/properties\/\$\{pick\.id\}`\)/);
    // 候補ありの分岐は submit(=setSearchText)へ落ちずに return する。
    const candidateBlock = branch.slice(
      branch.indexOf("suggestOpen && suggestResults.length > 0"),
      branch.indexOf("handleUnifiedSearchSubmit()"),
    );
    expect(candidateBlock).toContain("return;");
    expect(candidateBlock).not.toContain("setSearchText");
  });

  it("矢印キーで候補を選べる(キーボード操作の回復)", () => {
    expect(pageSrc).toContain('e.key === "ArrowDown"');
    expect(pageSrc).toContain('e.key === "ArrowUp"');
    expect(pageSrc).toContain('e.key === "Escape"');
    expect(pageSrc).toContain("activeSuggest");
  });
});
