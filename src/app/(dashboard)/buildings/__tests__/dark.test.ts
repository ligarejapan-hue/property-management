import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const listSrc = readFileSync(join(dir, "..", "page.tsx"), "utf8");
const detailSrc = readFileSync(join(dir, "..", "[id]", "page.tsx"), "utf8");

describe("buildings/page.tsx (棟一覧) dark: 配色", () => {
  // --- 面（背景） ---
  it("カード/パネルに dark:bg-gray-900 がある", () => {
    expect(listSrc).toContain("dark:bg-gray-900");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(listSrc).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(listSrc).toContain("dark:text-gray-100");
  });
  it("中間文字に dark:text-gray-200 がある", () => {
    expect(listSrc).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(listSrc).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(listSrc).toContain("dark:border-gray-800");
  });
  it("入力枠に dark:border-gray-700 がある", () => {
    expect(listSrc).toContain("dark:border-gray-700");
  });

  // --- 入力欄 ---
  it("入力欄に dark:bg-gray-900 がある", () => {
    // search input and modal inputs
    expect(listSrc.match(/dark:bg-gray-900/g)?.length ?? 0).toBeGreaterThan(1);
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(listSrc).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(listSrc).toContain("text-gray-600");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(listSrc).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(listSrc).toContain("hover:bg-gray-50");
  });
});

describe("buildings/[id]/page.tsx (棟詳細) dark: 配色", () => {
  // --- 面（背景） ---
  it("カード/パネルに dark:bg-gray-900 がある", () => {
    expect(detailSrc).toContain("dark:bg-gray-900");
  });
  it("テーブルヘッダに dark:bg-gray-800 がある", () => {
    expect(detailSrc).toContain("dark:bg-gray-800");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(detailSrc).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-100");
  });
  it("本文に dark:text-gray-300 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-400");
  });

  // --- 枠線/区切り ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(detailSrc).toContain("dark:border-gray-800");
  });
  it("枠線に dark:border-gray-700 がある", () => {
    expect(detailSrc).toContain("dark:border-gray-700");
  });
  it("テーブル行区切りに dark:divide-gray-800 がある", () => {
    expect(detailSrc).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 ---
  it("入力欄に dark:bg-gray-900 がある", () => {
    expect(detailSrc).toContain("dark:bg-gray-900");
  });
  it("AddUnitModal の入居状況 select が dark 入力3点セットを持つ", () => {
    // occupancyStatus select の className ブロックを抽出して3点セットを確認
    // className="..." の文字列でなく、select タグ開始からオプションまでの範囲で確認
    const occupancySection = detailSrc.slice(
      detailSrc.indexOf("入居状況"),
      detailSrc.indexOf("</select>", detailSrc.indexOf("入居状況")),
    );
    expect(occupancySection).toContain("dark:border-gray-700");
    expect(occupancySection).toContain("dark:bg-gray-900");
    expect(occupancySection).toContain("dark:text-gray-100");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(detailSrc).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(detailSrc).toContain("text-gray-600");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(detailSrc).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(detailSrc).toContain("hover:bg-gray-50");
  });
  it("ライトモード divide-gray-100 は残っている", () => {
    expect(detailSrc).toContain("divide-gray-100");
  });
});
