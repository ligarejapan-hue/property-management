import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "candidate-list.tsx"), "utf8");

describe("candidate-list.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（背景）---
  it("カード/パネル面 bg-white に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- hover 背景 ---
  it("hover:bg-gray-100 に dark:hover:bg-gray-700 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-700");
  });

  // --- 文字 ---
  it("text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("text-gray-400 に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });
  it("text-gray-600 (保留ボタン) に dark:text-gray-300 がある", () => {
    expect(src).toContain("text-gray-600 dark:text-gray-300 bg-gray-200 dark:bg-gray-700");
  });

  // --- 枠線 ---
  it("border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("border-gray-100 に dark:border-gray-800 がある", () => {
    // border-gray-100 → dark:border-gray-800（マッピング表通り）
    expect(src).toContain("dark:border-gray-800");
  });

  // --- リンク文字 accent 可読化 ---
  it("text-indigo-600 リンクに dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  // --- judgment 結果文字 accent 可読化 ---
  it("text-green-600 判定色に dark: が付いている", () => {
    expect(src).toContain("dark:text-green-400");
  });
  it("text-red-600 判定色に dark: が付いている", () => {
    expect(src).toContain("dark:text-red-400");
  });

  // --- 保留ボタン背景 ---
  it("bg-gray-200 (保留ボタン) に dark:bg-gray-700 がある", () => {
    expect(src).toContain("dark:bg-gray-700");
  });

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-100 は残っている", () => {
    expect(src).toContain("border-gray-100");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-400 は残っている", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード text-indigo-600 は残っている", () => {
    expect(src).toContain("text-indigo-600");
  });
  it("ライトモード text-green-600 は残っている", () => {
    expect(src).toContain("text-green-600");
  });
  it("ライトモード text-red-600 は残っている", () => {
    expect(src).toContain("text-red-600");
  });
  it("ライトモード hover:bg-gray-100 は残っている", () => {
    expect(src).toContain("hover:bg-gray-100");
  });
  it("ライトモード bg-gray-200 は残っている", () => {
    expect(src).toContain("bg-gray-200");
  });
});
