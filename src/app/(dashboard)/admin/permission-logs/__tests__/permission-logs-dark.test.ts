import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("admin/permission-logs/page.tsx dark: 配色 (admin残)", () => {
  // --- 面（背景） ---
  it("ページ背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("テーブルコンテナに dark:bg-gray-900 がある", () => {
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
  it("thead に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("tbody に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("主要見出し/本文1階調に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("薄い補助文字に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- accent 可読化（ChangeDetail diff badges） ---
  it("追加バッジ（bg-green-50）に dark:bg-green-500/10 がある", () => {
    expect(src).toContain("dark:bg-green-500/10");
  });
  it("追加バッジに dark:text-green-300 がある", () => {
    expect(src).toContain("dark:text-green-300");
  });
  it("削除バッジ（bg-red-50）に dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("削除バッジに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });

  // --- パンくず・リンク ---
  it("パンくずリンクに dark:hover:text-gray-300 がある", () => {
    expect(src).toContain("dark:hover:text-gray-300");
  });

  // --- 枠線・区切り ---
  it("テーブルコンテナ枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("テーブル区切り線に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- ページネーション ---
  it("ページネーションボタンに dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("ページネーションボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("ページネーションボタンホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- ライトモード不変担保 ---
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
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
  it("ライトモード text-gray-400 は残っている（空状態）", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });
  it("ライトモード bg-green-50 は残っている（追加バッジ）", () => {
    expect(src).toContain("bg-green-50");
  });
  it("ライトモード bg-red-50 は残っている（削除バッジ）", () => {
    expect(src).toContain("bg-red-50");
  });
  it("ライトモード text-green-700 は残っている（追加バッジ）", () => {
    expect(src).toContain("text-green-700");
  });
  it("ライトモード text-red-700 は残っている（削除バッジ）", () => {
    expect(src).toContain("text-red-700");
  });
});
