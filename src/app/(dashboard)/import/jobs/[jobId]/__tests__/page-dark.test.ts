import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("import/jobs/[jobId]/page.tsx dark: 配色", () => {
  // --- 面（背景） ---
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文系に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("本文系に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("本文系に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- アクセント ---
  it("indigo リンク/アクセント文字に dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  // --- カラーパネル（colored message panels） ---
  it("エラーパネルに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("情報パネルに dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("警告パネルに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("成功パネルに dark:text-green-300 がある", () => {
    expect(src).toContain("dark:text-green-300");
  });

  // --- 要素固有の組み合わせ（missed-section guard） ---
  it("ジョブサマリーカード: border-gray-200 bg-white と dark:border-gray-800 dark:bg-gray-900 が共存", () => {
    // mb-6 rounded-lg border ... bg-white p-5 のサマリカード
    const match = src.match(/border border-gray-200 bg-white[^"]*dark:border-gray-800 dark:bg-gray-900/);
    expect(match).not.toBeNull();
  });
  it("エラーパネル（classified=error）の bg と text に dark: が付いている", () => {
    // border-red-300 bg-red-50 の classified パネルが dark 化されている
    expect(src).toMatch(/border-red-300 bg-red-50[^"]*dark:bg-red-500\/10/);
  });
  it("amber 警告パネルの border/bg/text に dark: が付いている", () => {
    expect(src).toMatch(/border-amber-200 bg-amber-50[^"]*dark:bg-amber-500\/10/);
  });
  it("green 完了パネルの border/bg/text に dark: が付いている", () => {
    expect(src).toMatch(/border-green-200 bg-green-50[^"]*dark:bg-green-500\/10/);
  });
  it("rollback ダイアログの bg-white に dark:bg-gray-900 がある", () => {
    expect(src).toMatch(/rounded-lg bg-white shadow-xl[^"]*dark:bg-gray-900/);
  });

  // --- ライト側のクラスが依然存在する（不変担保） ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-red-700 は残っている", () => {
    expect(src).toContain("text-red-700");
  });
});

// 破壊系アウトラインボタン（ロールバック / 全件エラー確定 / 重複候補のみスキップ）は
// dark 背景・枠は付いたが文字色 dark が無く、暗背景で低コントラストだった（@codex #234 P2）。
// 汎用 dark:text-red/amber token は他のステータス文字でも通るため、各ボタン固有の
// light→dark クラス並びでピン留めして「そのボタンが直っている」ことを直接担保する。
describe("import/jobs/[jobId]/page.tsx dark: 破壊系アウトラインボタンの文字可読性", () => {
  it("ロールバックボタン(text-red-700)に dark:text-red-400 が付く", () => {
    expect(src).toMatch(/text-red-700 hover:bg-red-50 dark:bg-gray-900 dark:border-red-700 dark:text-red-400/);
  });
  it("一括「全件エラー確定」(text-red-600)に dark:text-red-400 が付く", () => {
    expect(src).toMatch(/text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:text-red-400/);
  });
  it("一括「重複候補のみスキップ」(text-amber-700)に dark:text-amber-400 が付く", () => {
    expect(src).toMatch(/text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400/);
  });
});
