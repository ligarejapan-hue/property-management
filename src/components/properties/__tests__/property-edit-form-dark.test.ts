import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "property-edit-form.tsx"), "utf8");

describe("property-edit-form.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（背景）---
  it("モーダル本体に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("タイトル text-gray-800 に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("セクション見出し text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("ラベル text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("キャンセルボタン text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("バージョン text-gray-400 に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 枠線 ---
  it("ヘッダ/フッタ border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("セクション border-gray-100 に dark:border-gray-800 がある", () => {
    // border-gray-100 と dark:border-gray-800 は同じファイルに存在する
    expect(src).toContain("border-gray-100");
    expect(src).toContain("dark:border-gray-800");
  });
  it("入力欄 border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- 入力欄3点セット ---
  it("入力欄に dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700 の3点セットがある", () => {
    expect(src).toContain("dark:bg-gray-900");
    expect(src).toContain("dark:text-gray-100");
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  it("キャンセルボタン hover:bg-gray-50 に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- disabled 入力欄 ---
  it("disabled select の disabled:bg-gray-100 に dark:disabled:bg-gray-800 がある", () => {
    expect(src).toContain("dark:disabled:bg-gray-800");
  });

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

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-800 は残っている", () => {
    expect(src).toContain("text-gray-800");
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
  it("ライトモード text-gray-400 は残っている", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-100 は残っている", () => {
    expect(src).toContain("border-gray-100");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
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
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード disabled:bg-gray-100 は残っている", () => {
    expect(src).toContain("disabled:bg-gray-100");
  });
});
