import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "current-location-status.tsx"), "utf8");

describe("current-location-status.tsx dark: 配色 (field-survey phase)", () => {
  // --- 文字 ---
  it("セクションラベルに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("dl 本文 text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- 枠 ---
  it("セクション区切り / 取得中メッセージ border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });

  // --- 取得中待ち状態メッセージ (bg-gray-50) ---
  it("取得中メッセージ面 bg-gray-50 に dark:bg-gray-800/50 または dark:bg-gray-900 がある", () => {
    const hasDarkBg =
      src.includes("dark:bg-gray-800/50") || src.includes("dark:bg-gray-900");
    expect(hasDarkBg).toBe(true);
  });

  // --- amber 低精度警告/エラーバナー ---
  it("低精度警告に dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("低精度警告に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("低精度警告に dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- blue accent 現在地へ移動ボタン ---
  it("現在地パンボタン (bg-blue-50) に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("現在地パンボタン (text-blue-700) に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("現在地パンボタン (border-blue-300) に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });

  // --- ライト不変担保 ---
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("ライトモード border-amber-300 は残っている", () => {
    expect(src).toContain("border-amber-300");
  });
  it("ライトモード bg-gray-50 は残っている (取得中メッセージ)", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード bg-blue-50 は残っている (パンボタン)", () => {
    expect(src).toContain("bg-blue-50");
  });
  it("ライトモード text-blue-700 は残っている", () => {
    expect(src).toContain("text-blue-700");
  });
  it("ライトモード border-blue-300 は残っている", () => {
    expect(src).toContain("border-blue-300");
  });
  it("ライトモード hover:bg-blue-100 は残っている", () => {
    expect(src).toContain("hover:bg-blue-100");
  });
});
