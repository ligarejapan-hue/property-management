import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("admin/change-password/page.tsx dark: 配色 (admin残)", () => {
  // --- 面（背景） ---
  it("カード面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("見出し/アイコンに dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("ラベルに dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("補助文に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("カード枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- 入力欄 3点セット ---
  it("パスワード入力欄背景に dark:bg-gray-900 がある", () => {
    // 3つの password input すべてに 3点セットを付ける
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });
  it("パスワード入力欄に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("パスワード入力欄に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("placeholder に dark:placeholder:text-gray-500 がある", () => {
    expect(src).toContain("dark:placeholder:text-gray-500");
  });

  // --- エラーバナー暗面可読化 ---
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナーに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("エラーバナーに dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- 成功バナー暗面可読化 ---
  it("成功バナーに dark:bg-green-500/10 がある", () => {
    expect(src).toContain("dark:bg-green-500/10");
  });
  it("成功バナーに dark:text-green-300 がある", () => {
    expect(src).toContain("dark:text-green-300");
  });
  it("成功バナーに dark:border-green-500/20 がある", () => {
    expect(src).toContain("dark:border-green-500/20");
  });

  // --- 題名 ---
  // 見出し横の鍵アイコンは廃止(2026-08-25 の見出し統一)。題名は共通部品
  // PageHeader が描き、暗面の配色も部品側が持つ。
  it("題名は PageHeader で描く", () => {
    expect(src).toContain('from "@/components/ui/page-header"');
    expect(src).toContain('<PageHeader title="パスワード変更" />');
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード bg-green-50 は残っている", () => {
    expect(src).toContain("bg-green-50");
  });
  it("ライトモード bg-red-50 は残っている", () => {
    expect(src).toContain("bg-red-50");
  });
  it("solid 送信ボタン bg-indigo-600 はそのまま残っている", () => {
    expect(src).toContain("bg-indigo-600");
  });
});
