import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("admin/attachments/trash/page.tsx dark: 配色 (admin残)", () => {
  // --- 面（背景） ---
  it("ページ背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("テーブルカード背景に dark:bg-gray-900 がある", () => {
    // overflow-hidden カード(bg-white)に dark:bg-gray-900 を追加
    expect(src).toContain("dark:bg-gray-900");
  });
  it("thead(bg-gray-50)に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("tbody 背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("見出し文字(text-gray-900)に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("補助文字(text-gray-500)に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠線/区切り ---
  it("カード枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- エラーバナー accent 可読化 ---
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナーに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナーに dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- ナビゲーション ---
  it("ナビリンクに dark:hover:text-gray-300 がある", () => {
    expect(src).toContain("dark:hover:text-gray-300");
  });

  // --- 中立バッジ (bg-gray-100 text-gray-800) ---
  it("種別バッジに dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });
  it("種別バッジに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- 復元ボタン (outline button: border-gray-300 bg-white text-gray-700) ---
  it("復元ボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("復元ボタン背景に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });
  it("復元ボタン文字に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("復元ボタンホバーに dark:hover:bg-gray-700 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-700");
  });

  // --- 復元不可テキスト (text-gray-400) ---
  it("復元不可メッセージに dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });
  it("ライトモード bg-gray-100 は残っている（バッジ）", () => {
    expect(src).toContain("bg-gray-100");
  });
});
