import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("field-survey/map/page.tsx dark: 配色 (Task D)", () => {
  // --- 面（背景） ---
  it("ヘッダーに dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("権限なし外枠に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("見出し h1 に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("説明文に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("ヘッダー下線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });

  // --- accent バナー（権限なし amber） ---
  it("amber バナーに dark:bg-amber-500/15 がある", () => {
    expect(src).toContain("dark:bg-amber-500/15");
  });
  it("amber バナーに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("amber バナー枠に dark:border-amber-500/40 がある", () => {
    expect(src).toContain("dark:border-amber-500/40");
  });

  // --- ライト不変（regression guard） ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  // 見出しの色は他画面(PageHeader)と揃えて text-gray-900 にした
  // (2026-08-25 の見出し統一)。大きさだけは地図の面積を守るため据え置き。
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(src).toContain("bg-gray-50");
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
  it("ライトモード text-amber-800 は残っている", () => {
    expect(src).toContain("text-amber-800");
  });
});
