import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "session-history-client.tsx"), "utf8");

describe("field-survey/session-history-client.tsx dark: 配色 (Task D)", () => {
  // --- 面（背景） ---
  it("テーブル tbody 背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("thead 背景に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });

  // --- 文字 ---
  it("フィルタラベル/thead に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字(ページ数/空欄)に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("インジゴリンクに dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  // --- 枠線・区切り ---
  it("テーブル枠に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("セレクト枠に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("tbody divide に dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });

  // --- input 3点セット（select） ---
  it("select に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("select に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });

  // --- accent バナー（エラー amber） ---
  it("エラーバナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("エラーバナーに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("エラーバナー枠に dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- ライト不変（regression guard） ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });
  it("ライトモード divide-gray-100 は残っている", () => {
    expect(src).toContain("divide-gray-100");
  });
  it("ライトモード text-indigo-600 は残っている", () => {
    expect(src).toContain("text-indigo-600");
  });
  it("ライトモード bg-amber-50 は残っている", () => {
    expect(src).toContain("bg-amber-50");
  });
  it("ライトモード border-amber-300 は残っている", () => {
    expect(src).toContain("border-amber-300");
  });
  it("ライトモード text-amber-900 は残っている", () => {
    expect(src).toContain("text-amber-900");
  });
});
