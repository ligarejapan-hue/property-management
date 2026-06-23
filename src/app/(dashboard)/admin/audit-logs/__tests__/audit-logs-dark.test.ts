import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("admin/audit-logs/page.tsx dark: 配色 (admin残)", () => {
  // --- 面（背景） ---
  it("dark:bg-gray-900 がある（ページ背景/フィルタ/テーブル/tbody/pre）", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("dark:bg-gray-900 が複数箇所にある（ページ背景・フィルタ・テーブル・pre を含む）", () => {
    // bg-white コンテナが dark:bg-gray-900 になる
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
  it("thead に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("展開行に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("主要見出し/本文1階調に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("ラベルに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("薄い補助文字に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });
  it("展開内 pre のテキストに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- accent 可読化 ---
  it("展開/折りたたみリンクに dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナーに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナーに dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- アクションバッジ (neutral) ---
  it("アクションバッジに dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });
  it("アクションバッジに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- 枠線・区切り ---
  it("カード/パネル枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("テーブル区切り線に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 3点セット + placeholder ---
  it("入力欄背景に dark:bg-gray-900 が複数ある", () => {
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
  it("入力欄に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("入力欄に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("placeholder に dark:placeholder:text-gray-500 がある", () => {
    expect(src).toContain("dark:placeholder:text-gray-500");
  });

  // --- ページネーション ---
  it("ページネーションボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("ページネーションボタン文字に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
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
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });
  it("ライトモード bg-gray-100 は残っている（アクションバッジ）", () => {
    expect(src).toContain("bg-gray-100");
  });
  it("ライトモード text-indigo-600 は残っている（展開リンク）", () => {
    expect(src).toContain("text-indigo-600");
  });
});
