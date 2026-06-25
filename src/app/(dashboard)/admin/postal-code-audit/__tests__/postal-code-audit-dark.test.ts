import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

// -----------------------------------------------------------------------
// postal-code-audit/page.tsx (郵便番号×住所 整合チェック) dark: 配色
// -----------------------------------------------------------------------
describe("postal-code-audit/page.tsx dark: 配色", () => {
  // --- 面（背景） ---
  it("テーブル tbody 面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("テーブルヘッダ面に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("本文/ラベルに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("サマリ文字 text-green-700 に dark: がある", () => {
    expect(src).toContain("dark:text-green-400");
  });
  it("サマリ文字 text-red-700 に dark: がある", () => {
    expect(src).toContain("dark:text-red-400");
  });
  it("サマリ文字 text-orange-700 に dark: がある", () => {
    expect(src).toContain("dark:text-orange-400");
  });

  // --- 枠線/区切り ---
  it("テーブル外枠に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("テーブル行区切りに dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });
  it("CSV ボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- タブ（フィルタタブ）---
  it("アクティブタブ文字に dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });
  it("非アクティブタブに dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- エラーバナー可読化 ---
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナー文字に dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });

  // --- オレンジ警告バナー可読化 ---
  it("警告バナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("警告バナー文字に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });

  // --- CSV ボタン（アウトライン）可読化 ---
  it("CSV ボタン文字に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- VERDICT_BADGE indeterminate (neutral) に dark: がある ---
  it("indeterminate バッジに dark:bg-gray-800 dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:bg-gray-800 dark:text-gray-300");
  });

  // --- ライトモード不変担保 ---
  it("ライトモード bg-white は残っている（テーブル tbody）", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている（テーブルヘッダ）", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード divide-gray-200 は残っている（tbody 区切り）", () => {
    expect(src).toContain("divide-gray-200");
  });

  // --- 分類/severity 色ロック非接触 ---
  it("match バッジ bg-green-100 text-green-700 は color-locked（dark: 未追加）", () => {
    // VERDICT_BADGE.match の行に dark: が混入していないことを確認
    expect(src).toContain('match: "bg-green-100 text-green-700"');
  });
  it("mismatch バッジ bg-red-100 text-red-700 は color-locked（dark: 未追加）", () => {
    expect(src).toContain('mismatch: "bg-red-100 text-red-700"');
  });
  it("not_processed バッジ bg-orange-100 text-orange-700 は color-locked（dark: 未追加）", () => {
    expect(src).toContain("bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700");
  });
  it("indigo-600 solid ボタンは据え置き（dark: 非追加）", () => {
    expect(src).toContain("bg-indigo-600");
  });
});
