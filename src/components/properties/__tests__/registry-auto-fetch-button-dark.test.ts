import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(dir, "..", "registry-auto-fetch-button.tsx"),
  "utf8",
);

describe("registry-auto-fetch-button.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- ライト不変担保（solid 色付きボタンはそのまま）---
  // このコンポーネントは solid 色付きボタン（bg-indigo-600 text-white）が主体。
  // solid ボタン自体は暗面でも視認可のため dark: 追加不要（constraints.md 参照）。
  it("ライトモード bg-indigo-600 は残っている (solid ボタン・dark 不要)", () => {
    expect(src).toContain("bg-indigo-600");
  });
  it("ライトモード text-white は残っている (solid ボタン・dark 不要)", () => {
    expect(src).toContain("text-white");
  });
  it("ライトモード hover:bg-indigo-700 は残っている", () => {
    expect(src).toContain("hover:bg-indigo-700");
  });

  // --- 確認パネル neutral 部分 ---
  // confirming パネルは accent (indigo-50/indigo-200) 地 + accent 文字のため
  // 暗面で読めない accent 文字は dark 化し、neutral なキャンセルボタンも dark 化する。
  it("確認パネル bg-indigo-50 に dark:bg-indigo-500/15 がある", () => {
    expect(src).toContain("dark:bg-indigo-500/15");
  });
  it("確認パネル border-indigo-200 に dark:border-indigo-500/30 がある", () => {
    expect(src).toContain("dark:border-indigo-500/30");
  });
  it("確認パネル text-indigo-800 に dark:text-indigo-300 がある", () => {
    expect(src).toContain("dark:text-indigo-300");
  });

  // --- キャンセルボタン (confirming パネル内の neutral ボタン) ---
  it("キャンセルボタン bg-white に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("キャンセルボタン text-gray-600 に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("キャンセルボタン border-gray-300 に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });
  it("キャンセルボタン hover:bg-gray-50 に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 状態テキスト accent 可読化 ---
  it("providerDisabled 文字 text-amber-700 に dark:text-amber-400 がある", () => {
    expect(src).toContain("dark:text-amber-400");
  });
  it("done 状態 text-green-600 に dark:text-green-400 がある", () => {
    expect(src).toContain("dark:text-green-400");
  });
  it("error 状態 text-red-600 に dark:text-red-400 がある", () => {
    expect(src).toContain("dark:text-red-400");
  });
  it("submitting 状態 text-gray-500 に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- ライト不変担保 ---
  it("ライトモード border-indigo-200 は残っている", () => {
    expect(src).toContain("border-indigo-200");
  });
  it("ライトモード bg-indigo-50 は残っている", () => {
    expect(src).toContain("bg-indigo-50");
  });
  it("ライトモード text-indigo-800 は残っている", () => {
    expect(src).toContain("text-indigo-800");
  });
  it("ライトモード text-indigo-700 は残っている", () => {
    expect(src).toContain("text-indigo-700");
  });
  it("ライトモード text-amber-700 は残っている", () => {
    expect(src).toContain("text-amber-700");
  });
  it("ライトモード text-green-600 は残っている", () => {
    expect(src).toContain("text-green-600");
  });
  it("ライトモード text-red-600 は残っている", () => {
    expect(src).toContain("text-red-600");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
});
