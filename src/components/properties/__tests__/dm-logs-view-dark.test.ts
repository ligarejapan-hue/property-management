import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "dm-logs-view.tsx"), "utf8");

describe("dm-logs-view.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（背景）---
  it("テーブルヘッダ bg-gray-50 に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });

  // --- hover 背景 ---
  it("行 hover:bg-gray-50 に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("text-gray-800 見出しに dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("text-gray-400 (空状態) に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });
  it("text-gray-300 (ダッシュ) に dark:text-gray-600 がある", () => {
    expect(src).toContain("dark:text-gray-600");
  });

  // --- 枠線 ---
  it("border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("border-gray-300 (ページネーションボタン) に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- divide ---
  it("divide-gray-100 に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- エラーバナー accent 可読化 ---
  it("エラーバナー bg-red-50 に dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナー text-red-700 に dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナー border-red-200 に dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード bg-red-50 は残っている", () => {
    expect(src).toContain("bg-red-50");
  });
  it("ライトモード border-red-200 は残っている", () => {
    expect(src).toContain("border-red-200");
  });
  it("ライトモード text-red-700 は残っている", () => {
    expect(src).toContain("text-red-700");
  });
  it("ライトモード text-gray-800 は残っている", () => {
    expect(src).toContain("text-gray-800");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-400 は残っている", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード text-gray-300 は残っている", () => {
    expect(src).toContain("text-gray-300");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード divide-gray-100 は残っている", () => {
    expect(src).toContain("divide-gray-100");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("data-pii-protected は維持されている", () => {
    expect(src).toContain("data-pii-protected");
  });
});
