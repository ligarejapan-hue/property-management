import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "location-recorder-controls.tsx"), "utf8");

describe("location-recorder-controls.tsx dark: 配色 (field-survey phase)", () => {
  // --- 面（背景） ---
  it("モーダル内パネルに dark:bg-gray-900 がある (bg-white 対応)", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("セクションラベルに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("dl カウンター本文に dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("モーダルタイトルに dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });

  // --- 枠 ---
  it("セクション区切り border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("停止ボタン/キャンセルボタン border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  it("停止/キャンセルボタン hover に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- amber 精度警告/エラーバナー ---
  it("精度警告/エラーバナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("精度警告/エラーバナーに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("精度警告/エラーバナーに dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- blue accent 位置記録開始ボタン ---
  it("位置記録開始ボタン (bg-blue-50) に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("位置記録開始ボタン (text-blue-700) に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("位置記録開始ボタン (border-blue-300) に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });

  // --- StatusLine 暗所可読化（最終レビュー対応・WCAG: amber-700 は暗背景で <4.5:1）---
  it("StatusLine エラー状態に text-amber-700 dark:text-amber-400 がある", () => {
    expect(src).toContain("text-amber-700 dark:text-amber-400");
  });
  it("StatusLine 記録中状態に text-red-600 dark:text-red-400 がある", () => {
    expect(src).toContain("text-red-600 dark:text-red-400");
  });
  it("StatusLine 既定状態に text-gray-600 dark:text-gray-300 がある", () => {
    expect(src).toContain("text-gray-600 dark:text-gray-300");
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード bg-blue-50 は残っている", () => {
    expect(src).toContain("bg-blue-50");
  });
  it("ライトモード text-blue-700 は残っている", () => {
    expect(src).toContain("text-blue-700");
  });
  it("ライトモード bg-indigo-600 solid ボタンは残っている", () => {
    expect(src).toContain("bg-indigo-600");
  });
  it("ライトモード text-red-600 は残っている (● 位置記録中)", () => {
    expect(src).toContain("text-red-600");
  });
});
