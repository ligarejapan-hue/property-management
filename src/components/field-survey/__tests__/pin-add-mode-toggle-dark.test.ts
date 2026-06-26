import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "pin-add-mode-toggle.tsx"), "utf8");

describe("pin-add-mode-toggle.tsx dark: 配色 (field-survey phase)", () => {
  // --- 文字 ---
  it("セクションラベルに dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("説明文 text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠 ---
  it("セクション区切り border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });

  // --- amber 権限なし警告文字 ---
  it("権限なし警告 text-amber-700 に dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });

  // --- inactive (non-active) 分岐の blue accent ダーク ---
  it("inactive 分岐 (bg-blue-50) に dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });
  it("inactive 分岐 (text-blue-700) に dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("inactive 分岐 (border-blue-300) に dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });

  // --- active 分岐は solid (bg-indigo-600 text-white) — dark 不要 / 不変担保 ---
  it("active 分岐 solid bg-indigo-600 は残っている (据え置き)", () => {
    expect(src).toContain("bg-indigo-600");
  });
  it("active 分岐 text-white は残っている", () => {
    expect(src).toContain("text-white");
  });

  // --- ライト不変担保 ---
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード bg-blue-50 は残っている (inactive 分岐)", () => {
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
  it("ライトモード text-amber-700 は残っている", () => {
    expect(src).toContain("text-amber-700");
  });
});
