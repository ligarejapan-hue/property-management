import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

// -----------------------------------------------------------------------
// display-name-audit/page.tsx (表示名監査) dark: 配色
// -----------------------------------------------------------------------
describe("display-name-audit/page.tsx dark: 配色", () => {
  // --- 面（背景） ---
  it("dark:bg-gray-900 がある（ページ背景/テーブルパネル/CSV ボタン）", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("dark:bg-gray-900 が複数箇所にある（ページ背景・テーブルパネル・CSV ボタンを含む）", () => {
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
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
  it("さらに薄い文字に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 枠線/区切り ---
  it("外枠に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("テーブル区切りに dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });
  it("CSV ボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- タブ ---
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

  // --- amber 警告バナー可読化 ---
  it("amber バナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("amber バナー文字に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });

  // --- CSV ボタン bg-white のアウトラインボタン ---
  it("CSV ボタン文字に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- バリアント件数バッジ（neutral/info）に dark: がある ---
  it("バリアント件数バッジに dark:bg-gray-800 dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:bg-gray-800 dark:text-gray-300");
  });

  // --- ナビ breadcrumb リンク可読化 ---
  it("breadcrumb ホバーに dark:hover:text-gray-200 がある", () => {
    expect(src).toContain("dark:hover:text-gray-200");
  });

  // --- ライトモード不変担保 ---
  it("ライトモード bg-gray-50 は残っている（ページ背景）", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード bg-white は残っている（パネル/ボタン）", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている（行ホバー / CSV ボタン）", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード border-red-200 は残っている（エラーバナー枠）", () => {
    expect(src).toContain("border-red-200");
  });
  it("ライトモード border-amber-200 は残っている（amber バナー枠）", () => {
    expect(src).toContain("border-amber-200");
  });
});
