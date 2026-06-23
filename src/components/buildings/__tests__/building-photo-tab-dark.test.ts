import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "building-photo-tab.tsx"), "utf8");

describe("building-photo-tab.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- エラーバナー accent 可読化 ---
  it("エラーバナー背景に dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナー文字に dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナー枠に dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- 面（背景）---
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("サムネイル背景 bg-gray-100 に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });

  // --- hover 背景 ---
  it("hover:bg-gray-50 に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- reorder active (T1レビュー対応) ---
  it("並び替えボタン active 状態に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });
  it("並び替えボタン active 状態に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });

  // --- 文字 ---
  it("text-gray-900 に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("text-gray-300（鉛筆アイコン）に dark:text-gray-600 がある", () => {
    expect(src).toContain("dark:text-gray-600");
  });

  // --- 枠線 ---
  it("border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-red-50 は残っている", () => {
    expect(src).toContain("bg-red-50");
  });
  it("ライトモード text-red-700 は残っている", () => {
    expect(src).toContain("text-red-700");
  });
  it("ライトモード border-red-200 は残っている", () => {
    expect(src).toContain("border-red-200");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード bg-gray-100 は残っている", () => {
    expect(src).toContain("bg-gray-100");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("loading='lazy' は維持されている", () => {
    expect(src).toContain('loading="lazy"');
  });
});
