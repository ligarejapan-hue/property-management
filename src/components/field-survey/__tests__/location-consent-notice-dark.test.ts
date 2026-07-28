/**
 * 位置記録の説明文 (共有部品) の dark 配色。
 *
 * location-recorder-controls.tsx にあった同意 modal をここへ移したため、
 * 元ファイルで見ていた配色の表明を引き継ぐ (削除ではなく移設)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(dir, "..", "location-consent-notice.tsx"),
  "utf8",
);

describe("location-consent-notice.tsx dark: 配色", () => {
  it("modal パネルに dark:bg-gray-900 がある (bg-white 対応)", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("modal タイトルに dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("本文に dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("キャンセルボタン枠 border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-indigo-600 solid ボタンは残っている", () => {
    expect(src).toContain("bg-indigo-600");
  });
});
