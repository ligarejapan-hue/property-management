import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "candidate-list.tsx"), "utf8");

describe("candidate-list.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（背景）---
  it("カード/パネル面 bg-white に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- hover 背景 ---
  // UIの統一 第3回: 開閉ボタンは共通 Button の ghost(hover の暗い面の配色は部品側が持つ)
  it("開閉ボタンは共通 Button の ghost(hover の配色は部品側)", () => {
    expect(src).toContain('variant="ghost"');
  });

  // --- 文字 ---
  it("text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("text-gray-700 に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("text-gray-400 に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });
  // UIの統一 第3回: 判定の3ボタンは共通 Button(同一=success・別=danger・保留=secondary)。配色は部品側
  it("判定の3ボタンは共通 Button の success / danger / secondary", () => {
    expect(src).toContain('variant="success"');
    expect(src).toContain('variant="danger"');
    expect(src).toContain('variant="secondary"');
  });

  // --- 枠線 ---
  it("border-gray-200 に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("border-gray-100 に dark:border-gray-800 がある", () => {
    // border-gray-100 → dark:border-gray-800（マッピング表通り）
    expect(src).toContain("dark:border-gray-800");
  });

  // --- 強度ボーダー(左色)のダーク保全 ---
  // dark:border-gray-800 は全辺のborder-colorを塗るため、dark:border-l-* が無いと
  // ダークで左の強度色(赤/橙/青)が上書きされ消える（@codex P3 / add-only違反）。回帰防止。
  it("強(border-l-red-500) の左色に dark:border-l-red-400 がある", () => {
    expect(src).toContain("dark:border-l-red-400");
  });
  it("中(border-l-amber-500) の左色に dark:border-l-amber-400 がある", () => {
    expect(src).toContain("dark:border-l-amber-400");
  });
  it("弱(border-l-blue-500) の左色に dark:border-l-blue-400 がある", () => {
    expect(src).toContain("dark:border-l-blue-400");
  });

  // --- リンク文字 accent 可読化 ---
  it("text-indigo-600 リンクに dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  // --- judgment 結果文字 accent 可読化 ---
  it("text-green-600 判定色に dark: が付いている", () => {
    expect(src).toContain("dark:text-green-400");
  });
  it("text-red-600 判定色に dark: が付いている", () => {
    expect(src).toContain("dark:text-red-400");
  });

  // --- ライト不変担保（add-only の証跡）---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-100 は残っている", () => {
    expect(src).toContain("border-gray-100");
  });
  it("ライトモード 強度色 border-l-red-500 は残っている", () => {
    expect(src).toContain("border-l-red-500");
  });
  it("ライトモード 強度色 border-l-amber-500 は残っている", () => {
    expect(src).toContain("border-l-amber-500");
  });
  it("ライトモード 強度色 border-l-blue-500 は残っている", () => {
    expect(src).toContain("border-l-blue-500");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-400 は残っている", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード text-indigo-600 は残っている", () => {
    expect(src).toContain("text-indigo-600");
  });
  it("ライトモード text-green-600 は残っている", () => {
    expect(src).toContain("text-green-600");
  });
  it("ライトモード text-red-600 は残っている", () => {
    expect(src).toContain("text-red-600");
  });
  // hover:bg-gray-100(開閉)・bg-gray-200(保留)はボタンの色だった=共通 Button へ移った(上の2本で担保)
});
