import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("field-survey/sessions/page.tsx dark: 配色 (Task D)", () => {
  // --- 面（背景） ---
  it("ヘッダーに dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 文字 ---
  it("見出し・説明文は共通 PageHeader(dark:text-gray-100/400 は部品側で担保・第2弾⑧)", () => {
    expect(src).toContain('from "@/components/ui/page-header"');
    expect(src).toContain("<PageHeader");
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
  it("ライトモードの文字色は PageHeader 部品側に移った(第2弾⑧)", () => {
    // 旧 h1(text-gray-800)/説明(text-gray-500)は部品の text-gray-900/500 に統一。
    expect(src).toContain("<PageHeader");
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
