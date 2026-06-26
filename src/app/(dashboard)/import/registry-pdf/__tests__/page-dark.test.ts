import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("import/registry-pdf/page.tsx dark: 配色", () => {
  // --- 面（背景） ---
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("薄背景に dark:bg-gray-800/50 がある", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文系に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("本文系に dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("本文系に dark:text-gray-300 がある", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- アクセント ---
  it("active タブ/リンクに dark:text-indigo-400 がある", () => {
    expect(src).toContain("dark:text-indigo-400");
  });

  // --- 色付きパネル ---
  it("赤パネルに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });
  it("青パネルに dark:text-blue-300 がある", () => {
    expect(src).toContain("dark:text-blue-300");
  });
  it("黄amber警告パネルに dark:text-amber-300 がある", () => {
    expect(src).toContain("dark:text-amber-300");
  });
  it("緑成功に dark:bg-green-500/10 がある", () => {
    expect(src).toContain("dark:bg-green-500/10");
  });

  // --- ライト側のクラスが依然存在する（不変担保） ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード text-red-700 は残っている", () => {
    expect(src).toContain("text-red-700");
  });

  // --- ELEMENT-SPECIFIC: 個別セクションが darken 済みであること ---
  it("Step 1 アップロードカード: bg-white と dark:bg-gray-900 が同一クラス属性に共存する", () => {
    const match = src.match(/className="[^"]*rounded-lg border border-gray-200[^"]*bg-white[^"]*"/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("dark:bg-gray-900");
  });
  it("Step 2 抽出フィールド input: border-gray-300 と dark:border-gray-700 が共存する", () => {
    const match = src.match(/className="[^"]*border border-gray-300[^"]*dark:border-gray-700[^"]*"/);
    expect(match).not.toBeNull();
  });
  it("警告パネル: border-amber-200 と dark:border-amber-400/20 が共存する", () => {
    const match = src.match(/className="[^"]*border-amber-200[^"]*dark:border-amber-400\/20[^"]*"/);
    expect(match).not.toBeNull();
  });
  it("赤パネル: bg-red-50 と dark:bg-red-500/10 が共存する", () => {
    const match = src.match(/className="[^"]*bg-red-50[^"]*dark:bg-red-500\/10[^"]*"/);
    expect(match).not.toBeNull();
  });
  it("プロパティ検索結果リスト: bg-white と dark:bg-gray-900 が共存する", () => {
    const match = src.match(/className="[^"]*rounded border border-gray-200[^"]*bg-white[^"]*"/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain("dark:bg-gray-900");
  });
});
