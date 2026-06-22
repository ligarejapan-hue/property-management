import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const detailSrc = readFileSync(join(dir, "..", "[id]", "page.tsx"), "utf8");
const hygieneSrc = readFileSync(
  join(dir, "..", "text-hygiene", "page.tsx"),
  "utf8",
);

// -----------------------------------------------------------------------
// owners/[id]/page.tsx (所有者詳細) dark: 配色 (O1)
// -----------------------------------------------------------------------
describe("owners/[id]/page.tsx dark: 配色 (O1)", () => {
  // --- 面（背景） ---
  it("カード/パネルに dark:bg-gray-900 がある", () => {
    expect(detailSrc).toContain("dark:bg-gray-900");
  });

  // --- 文字（2階調以上） ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-100");
  });
  it("ラベル文字に dark:text-gray-200 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-400");
  });
  it("薄文字に dark:text-gray-500 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-500");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(detailSrc).toContain("dark:border-gray-800");
  });

  // --- 入力欄 3点セット ---
  it("入力欄に dark:bg-gray-900 がある", () => {
    // input の dark 面（カード面と重複して使用）
    const count = (detailSrc.match(/dark:bg-gray-900/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });
  it("入力欄文字に dark:text-gray-100 がある", () => {
    expect(detailSrc).toContain("dark:text-gray-100");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(detailSrc).toContain("dark:border-gray-700");
  });
  it("入力欄プレースホルダに dark:placeholder:text-gray-500 がある", () => {
    expect(detailSrc).toContain("dark:placeholder:text-gray-500");
  });

  // --- hover 可読化（backlink） ---
  it("back リンクに dark:hover:text-gray-200 がある", () => {
    expect(detailSrc).toContain("dark:hover:text-gray-200");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(detailSrc).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(detailSrc).toContain("border-gray-200");
  });
  it("ライトモード text-gray-700 は残っている", () => {
    expect(detailSrc).toContain("text-gray-700");
  });

  // --- 分類タグ（TYPE_BADGE）accent 非接触確認 ---
  it("TYPE_BADGE に yellow accent が残っている（color-locked・dark 変換なし）", () => {
    // missing=yellow は accent 据え置き（color-locked）
    expect(detailSrc).toContain("bg-yellow-100 text-yellow-800 border-yellow-300");
  });
  it("TYPE_BADGE に accent dark:bg-yellow は混入していない", () => {
    // yellow 分類タグは dark: 変換しない
    const noYellowDark = ["dark:bg-yellow"].join("");
    expect(detailSrc).not.toContain(noYellowDark);
  });
});

// -----------------------------------------------------------------------
// owners/text-hygiene/page.tsx (文字化け監査) dark: 配色 (O1)
// -----------------------------------------------------------------------
describe("owners/text-hygiene/page.tsx dark: 配色 (O1)", () => {
  // --- 面（背景） ---
  it("ページ背景に dark:bg-gray-900 がある", () => {
    expect(hygieneSrc).toContain("dark:bg-gray-900");
  });
  it("テーブルヘッダに dark:bg-gray-800 がある", () => {
    expect(hygieneSrc).toContain("dark:bg-gray-800");
  });
  it("行ホバーに dark:hover:bg-gray-800 がある", () => {
    expect(hygieneSrc).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字（2階調以上） ---
  it("見出し文字に dark:text-gray-100 がある", () => {
    expect(hygieneSrc).toContain("dark:text-gray-100");
  });
  it("本文に dark:text-gray-200 がある", () => {
    expect(hygieneSrc).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-300 がある（SEVERITY_CLASS info 対応）", () => {
    expect(hygieneSrc).toContain("dark:text-gray-300");
  });
  it("薄文字に dark:text-gray-400 がある", () => {
    expect(hygieneSrc).toContain("dark:text-gray-400");
  });

  // --- 枠線/区切り ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(hygieneSrc).toContain("dark:border-gray-800");
  });
  it("テーブル行区切りに dark:divide-gray-800 がある", () => {
    expect(hygieneSrc).toContain("dark:divide-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある（ボタン等）", () => {
    expect(hygieneSrc).toContain("dark:border-gray-700");
  });

  // --- hover 可読化（フィルタボタン非選択状態） ---
  it("フィルタボタン非選択に dark:hover:bg-gray-800 がある", () => {
    expect(hygieneSrc).toContain("dark:hover:bg-gray-800");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-gray-50 は残っている（thead）", () => {
    expect(hygieneSrc).toContain("bg-gray-50");
  });
  it("ライトモード bg-white は残っている（テーブル/ボタン）", () => {
    expect(hygieneSrc).toContain("bg-white");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(hygieneSrc).toContain("text-gray-600");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(hygieneSrc).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(hygieneSrc).toContain("hover:bg-gray-50");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(hygieneSrc).toContain("divide-gray-200");
  });
});
