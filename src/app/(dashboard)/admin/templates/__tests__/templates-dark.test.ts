import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const listPage = readFileSync(join(dir, "..", "page.tsx"), "utf8");
const editPage = readFileSync(join(dir, "..", "[id]", "page.tsx"), "utf8");

// ============================================================
// admin/templates/page.tsx (テンプレート一覧)
// ============================================================
describe("admin/templates/page.tsx dark: 配色 (A2)", () => {
  // --- 面（背景） ---
  it("ページ背景に暗背景クラスがある", () => {
    expect(listPage).toContain("dark:bg-gray-900");
  });
  it("thead に暗背景クラスがある", () => {
    expect(listPage).toContain("dark:bg-gray-800");
  });
  it("行ホバーに暗ホバークラスがある", () => {
    expect(listPage).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文1階調に暗テキストクラスがある", () => {
    expect(listPage).toContain("dark:text-gray-100");
  });
  it("本文2階調に暗テキストクラスがある", () => {
    expect(listPage).toContain("dark:text-gray-200");
  });
  it("補助文字に暗テキストクラスがある", () => {
    expect(listPage).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("カード枠線に dark:border-gray-800 がある", () => {
    expect(listPage).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(listPage).toContain("dark:border-gray-700");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(listPage).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 3点セット（bg=gray-900 で統一） ---
  it("入力欄背景が dark:bg-gray-900 である", () => {
    // input/textarea の dark:bg は gray-900（spec指定）
    const inputBgCount = (listPage.match(/dark:bg-gray-900/g) ?? []).length;
    expect(inputBgCount).toBeGreaterThanOrEqual(2);
  });
  it("入力欄に暗テキストクラスがある", () => {
    expect(listPage).toContain("dark:text-gray-100");
  });
  it("入力欄に dark:border-gray-700 がある", () => {
    expect(listPage).toContain("dark:border-gray-700");
  });
  it("placeholder に暗クラスがある", () => {
    expect(listPage).toContain("dark:placeholder:text-gray-500");
  });

  // --- hover 可読化 ---
  it("アクセントリンクに dark:text-indigo-400 がある", () => {
    expect(listPage).toContain("dark:text-indigo-400");
  });

  // --- モーダルパネル ---
  it("モーダルパネルに暗背景クラスがある", () => {
    expect(listPage).toContain("dark:bg-gray-900");
  });
  it("モーダルキャンセルボタン枠線に dark:border-gray-700 がある", () => {
    expect(listPage).toContain("dark:border-gray-700");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(listPage).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(listPage).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(listPage).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(listPage).toContain("border-gray-300");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(listPage).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(listPage).toContain("text-gray-500");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(listPage).toContain("divide-gray-200");
  });
});

// ============================================================
// admin/templates/[id]/page.tsx (テンプレート編集)
// ============================================================
describe("admin/templates/[id]/page.tsx dark: 配色 (A2)", () => {
  // --- 面（背景） ---
  it("ページ背景に暗背景クラスがある", () => {
    expect(editPage).toContain("dark:bg-gray-900");
  });
  it("thead に暗背景クラスがある", () => {
    expect(editPage).toContain("dark:bg-gray-800");
  });
  it("行ホバーに暗ホバークラスがある", () => {
    expect(editPage).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文1階調に暗テキストクラスがある", () => {
    expect(editPage).toContain("dark:text-gray-100");
  });
  it("本文2階調に暗テキストクラスがある", () => {
    expect(editPage).toContain("dark:text-gray-200");
  });
  it("補助文字に dark:text-gray-400 がある", () => {
    expect(editPage).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("カード枠線に dark:border-gray-800 がある", () => {
    expect(editPage).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(editPage).toContain("dark:border-gray-700");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(editPage).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 3点セット（input・textarea、bg=gray-900） ---
  it("テキスト入力欄背景が dark:bg-gray-900 である", () => {
    expect(editPage).toContain("dark:bg-gray-900");
  });
  it("テキスト入力欄に暗テキストクラスがある", () => {
    const hasInputDark =
      editPage.includes("dark:text-gray-100") &&
      editPage.includes("dark:border-gray-700") &&
      editPage.includes("dark:bg-gray-900");
    expect(hasInputDark).toBe(true);
  });
  it("textarea（説明欄）に dark:bg-gray-900 がある", () => {
    // textarea の dark:bg は gray-900（spec指定・gray-800 にしない）
    const textareaSection = editPage.slice(editPage.indexOf("tpl-desc"));
    expect(textareaSection).toContain("dark:bg-gray-900");
  });

  // --- 未選択バッジ（条件分岐内） ---
  it("未許可バッジ（bg-gray-100）に dark:bg-gray-800 がある", () => {
    expect(editPage).toContain("dark:bg-gray-800");
  });
  it("未許可バッジに dark:text-gray-400 がある", () => {
    expect(editPage).toContain("dark:text-gray-400");
  });

  // --- メッセージテキスト ---
  it("エラーメッセージに dark:text-red-400 がある", () => {
    expect(editPage).toContain("dark:text-red-400");
  });
  it("成功メッセージに dark:text-green-400 がある", () => {
    expect(editPage).toContain("dark:text-green-400");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(editPage).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(editPage).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(editPage).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(editPage).toContain("border-gray-300");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(editPage).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(editPage).toContain("text-gray-500");
  });
  it("ライトモード text-gray-900 は残っている", () => {
    expect(editPage).toContain("text-gray-900");
  });
  it("ライトモード divide-gray-200 は残っている", () => {
    expect(editPage).toContain("divide-gray-200");
  });
  it("ライトモード bg-gray-100 は残っている（未許可バッジ）", () => {
    expect(editPage).toContain("bg-gray-100");
  });
});
