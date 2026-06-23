import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "investigation-tab.tsx"), "utf8");

describe("investigation-tab.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（背景）---
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("淡面 bg-gray-50 に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });

  // --- hover 背景 ---
  it("hover:bg-gray-50 に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("text-gray-400 に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 枠線 ---
  it("border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("divide-gray-100 に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 3点セット ---
  it("入力欄に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("入力欄に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
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

  // --- 成功フラッシュ accent 可読化 ---
  it("成功フラッシュ背景に dark:bg-green-500/10 がある", () => {
    expect(src).toContain("dark:bg-green-500/10");
  });
  it("成功フラッシュ文字に dark:text-green-300 がある", () => {
    expect(src).toContain("dark:text-green-300");
  });
  it("成功フラッシュ枠に dark:border-green-500/20 がある", () => {
    expect(src).toContain("dark:border-green-500/20");
  });

  // --- amber 警告ボックス accent 可読化 ---
  it("amber 警告ボックス背景に dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("amber 警告ボックス文字に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("amber 警告ボックス枠に dark:border-amber-500/20 がある", () => {
    expect(src).toContain("dark:border-amber-500/20");
  });

  // --- 取得ボタン（active accent 分岐）---
  it("取得ボタン active 状態に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });
  it("取得ボタン active 状態に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("取得ボタン active 状態に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });

  // --- 参考情報ボックス（blue） ---
  it("参考情報ボックスに dark:bg-blue-500/15 がある", () => {
    expect(src).toContain("dark:bg-blue-500/15");
  });
  it("参考情報ボックス文字に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });

  // --- セル文字色（caution=amber） ---
  it("caution セル文字 text-amber-600 に dark:text-amber-400 がある", () => {
    expect(src).toContain("dark:text-amber-400");
  });

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
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
  it("ライトモード bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("ライトモード border-amber-200 は残っている", () => {
    expect(src).toContain("border-amber-200");
  });
  it("ライトモード bg-blue-50 は残っている", () => {
    expect(src).toContain("bg-blue-50");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード divide-gray-100 は残っている", () => {
    expect(src).toContain("divide-gray-100");
  });
  it("ライトモード border-blue-300 は残っている", () => {
    expect(src).toContain("border-blue-300");
  });
  it("ライトモード text-blue-700 は残っている", () => {
    expect(src).toContain("text-blue-700");
  });
  it("ライトモード text-amber-800 は残っている", () => {
    expect(src).toContain("text-amber-800");
  });
});
