import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "trip-controls.tsx"), "utf8");

describe("trip-controls.tsx dark: 配色 (field-survey phase)", () => {
  // --- 面（背景） ---
  it("ModalShell 内パネルに dark:bg-gray-900 がある (bg-white 対応)", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("セクションラベルに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字・補足テキストに dark:text-gray-400 がある (text-gray-500 対応)", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("dl 本文・本文テキストに dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("モーダルタイトルに dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("モーダル本文 text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });

  // --- 枠 ---
  it("Panel / セクション区切り border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("キャンセルボタン枠 border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  it("キャンセルボタン hover に dark:hover:bg-gray-800 がある (hover:bg-gray-50 対応)", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- amber エラーバナー ---
  it("エラーバナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("エラーバナーに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("エラーバナーに dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- blue accent 巡回開始ボタン（inactive/accent 分岐） ---
  it("巡回開始ボタン (bg-blue-50) に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("巡回開始ボタン (text-blue-700) に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("巡回開始ボタン (border-blue-300) に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });

  // --- red accent 巡回終了ボタン ---
  it("巡回終了ボタン (bg-red-50) に dark:bg-red-500/20 がある", () => {
    expect(src).toContain("dark:bg-red-500/20");
  });
  it("巡回終了ボタン (text-red-700) に dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("巡回終了ボタン (border-red-300) に dark:border-red-500/40 がある", () => {
    expect(src).toContain("dark:border-red-500/40");
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
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
  it("ライトモード text-gray-800 は残っている", () => {
    expect(src).toContain("text-gray-800");
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
  it("ライトモード bg-blue-50 は残っている (IdleView/現在地ボタン)", () => {
    expect(src).toContain("bg-blue-50");
  });
  it("ライトモード text-blue-700 は残っている", () => {
    expect(src).toContain("text-blue-700");
  });
  it("ライトモード bg-indigo-600 solid ボタンは残っている (ModalActions agree)", () => {
    expect(src).toContain("bg-indigo-600");
  });
});
