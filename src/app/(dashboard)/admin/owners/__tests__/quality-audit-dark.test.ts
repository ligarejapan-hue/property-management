import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "quality-audit", "page.tsx"), "utf8");

// -----------------------------------------------------------------------
// owners/quality-audit/page.tsx (品質監査) dark: 配色 (O2)
// -----------------------------------------------------------------------
describe("owners/quality-audit/page.tsx dark: 配色 (O2)", () => {
  // --- 面（背景） ---
  it("ページ背景に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("テーブルヘッダ面に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字（2階調以上） ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("本文/ラベルに dark:text-gray-200 がある", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-300 がある（SEVERITY_CLASS info 対応）", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("さらに薄い文字に dark:text-gray-500 がある", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 枠線/区切り ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("テーブル行区切りに dark:divide-gray-800 がある", () => {
    expect(src).toContain("dark:divide-gray-800");
  });
  it("入力欄系ボタン枠線に dark:border-gray-700 がある", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- 品質テーブル thead/tbody 対応 ---
  it("名前テーブル thead に dark:bg-gray-800 がある", () => {
    // bg-gray-50 dark:bg-gray-800 がthead両方に存在
    const count = (src.match(/bg-gray-50 dark:bg-gray-800/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
  it("名前テーブル tbody に dark:bg-gray-900 がある", () => {
    // bg-white dark:... dark:bg-gray-900 がtbody両方に存在
    const count = (src.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // --- hover 可読化（フィルタボタン/タブ非選択）---
  it("フィルタボタン非選択に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });
  it("タブ非選択に dark:text-gray-400 がある", () => {
    expect(src).toContain("dark:text-gray-400");
  });

  // --- SEVERITY_CLASS info (neutral) に dark: がある ---
  it("SEVERITY_CLASS info に dark:bg-gray-800 がある", () => {
    expect(src).toContain("dark:bg-gray-800 dark:text-gray-300");
  });

  // --- REC_BADGE hold (neutral) に dark: がある ---
  it("REC_BADGE hold に dark:bg-gray-800 がある", () => {
    // hold エントリに dark:bg-gray-800 が含まれることをソース文字列で確認
    expect(src).toContain("bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-gray-50 は残っている（thead）", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード bg-white は残っている（テーブル tbody / ボタン）", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(src).toContain("text-gray-900");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(src).toContain("hover:bg-gray-50");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(src).toContain("divide-gray-200");
  });

  // --- 分類タグ/severity 色ロック非接触 ---
  it("error severity クラスに dark: 変換が混入していない（color-locked）", () => {
    // error: "bg-red-100 text-red-700" のみ（dark: を追加しない）
    const noDarkRed = ["dark:bg-red-1"].join("");
    expect(src).not.toContain(noDarkRed);
  });
  it("warning severity クラスに dark: 変換が混入していない（color-locked）", () => {
    const noDarkAmber = ["dark:bg-amber-1"].join("");
    expect(src).not.toContain(noDarkAmber);
  });
  it("sanitize_candidate/format_candidate バッジに dark: 変換が混入していない（accent 据え置き）", () => {
    const noDarkEmerald = ["dark:bg-emerald"].join("");
    expect(src).not.toContain(noDarkEmerald);
  });
  it("accent ボタン（bg-emerald-600）は dark: 据え置き", () => {
    expect(src).toContain("bg-emerald-600");
  });
});
