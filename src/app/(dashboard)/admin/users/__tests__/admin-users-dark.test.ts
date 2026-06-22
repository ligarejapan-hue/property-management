import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const usersPage = readFileSync(join(dir, "..", "page.tsx"), "utf8");
const permissionsPage = readFileSync(
  join(dir, "..", "[id]", "permissions", "page.tsx"),
  "utf8",
);

// ============================================================
// users/page.tsx
// ============================================================
describe("admin/users/page.tsx dark: 配色 (A1)", () => {
  // --- 面（背景） ---
  it("カード/テーブル面に暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-gray-900");
  });
  it("thead に暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-gray-800");
  });
  it("行ホバーに暗ホバークラスがある", () => {
    expect(usersPage).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文1階調に暗テキストクラスがある", () => {
    expect(usersPage).toContain("dark:text-gray-100");
  });
  it("本文2階調に暗テキストクラスがある", () => {
    expect(usersPage).toContain("dark:text-gray-200");
  });
  it("補助文字に暗テキストクラスがある", () => {
    expect(usersPage).toContain("dark:text-gray-400");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(usersPage).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある", () => {
    expect(usersPage).toContain("dark:border-gray-700");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(usersPage).toContain("dark:divide-gray-800");
  });

  // --- 入力欄 3点セット ---
  it("入力欄に暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-gray-900");
  });
  it("入力欄に暗テキストクラスがある", () => {
    // 入力欄の text-gray-900 に対応
    const hasInputDark =
      usersPage.includes("dark:text-gray-100") &&
      usersPage.includes("dark:bg-gray-900") &&
      usersPage.includes("dark:border-gray-700");
    expect(hasInputDark).toBe(true);
  });
  it("placeholder に暗クラスがある", () => {
    expect(usersPage).toContain("dark:placeholder:text-gray-500");
  });

  // --- アクションボタン暗クラス ---
  it("無効化ボタン（amber）に dark:text-amber-400 がある", () => {
    expect(usersPage).toContain("dark:text-amber-400");
  });
  it("有効化ボタン（emerald）に dark:text-emerald-400 がある", () => {
    expect(usersPage).toContain("dark:text-emerald-400");
  });
  it("削除/解除ボタン（red）に dark:text-red-400 がある", () => {
    expect(usersPage).toContain("dark:text-red-400");
  });

  // --- hover 可読化 ---
  it("アクセントリンクに暗テキストクラスがある", () => {
    expect(usersPage).toContain("dark:text-indigo-400");
  });
  it("フラッシュバナー（成功）に暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-green-500/15");
  });
  it("フラッシュバナー（エラー）に暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-red-500/15");
  });

  // --- モーダル ---
  it("確認ダイアログのパネルに暗背景クラスがある", () => {
    expect(usersPage).toContain("dark:bg-gray-900");
  });
  it("キャンセルボタン枠線に暗枠クラスがある", () => {
    expect(usersPage).toContain("dark:border-gray-700");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(usersPage).toContain("bg-white");
  });
  it("ライトモード border-gray-300 は残っている", () => {
    expect(usersPage).toContain("border-gray-300");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(usersPage).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(usersPage).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(usersPage).toContain("text-gray-600");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(usersPage).toContain("bg-gray-50");
  });
});

// ============================================================
// admin/users/[id]/permissions/page.tsx
// ============================================================
describe("admin/users/[id]/permissions/page.tsx dark: 配色 (A1)", () => {
  // --- 面（背景） ---
  it("ページ背景に暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-gray-900");
  });
  it("テーブルthead に暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-gray-800");
  });
  it("行ホバーに暗ホバークラスがある", () => {
    expect(permissionsPage).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("本文1階調に暗テキストクラスがある", () => {
    expect(permissionsPage).toContain("dark:text-gray-100");
  });
  it("補助文字に暗テキストクラスがある", () => {
    expect(permissionsPage).toContain("dark:text-gray-400");
  });
  it("本文系に dark:text-gray-300 がある", () => {
    expect(permissionsPage).toContain("dark:text-gray-300");
  });

  // --- 枠線 ---
  it("枠線に dark:border-gray-800 がある", () => {
    expect(permissionsPage).toContain("dark:border-gray-800");
  });
  it("select 枠線に dark:border-gray-700 がある", () => {
    expect(permissionsPage).toContain("dark:border-gray-700");
  });
  it("テーブル行境界に dark:divide-gray-800 がある", () => {
    expect(permissionsPage).toContain("dark:divide-gray-800");
  });

  // --- select 入力欄 3点セット ---
  it("select に暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-gray-800");
  });
  it("select に暗テキストクラスがある", () => {
    const hasSelectDark =
      permissionsPage.includes("dark:bg-gray-800") &&
      permissionsPage.includes("dark:border-gray-700") &&
      permissionsPage.includes("dark:text-gray-100");
    expect(hasSelectDark).toBe(true);
  });

  // --- 保存メッセージ暗クラス ---
  it("保存エラーメッセージに dark:text-red-400 がある", () => {
    expect(permissionsPage).toContain("dark:text-red-400");
  });
  it("保存成功メッセージに dark:text-green-400 がある", () => {
    expect(permissionsPage).toContain("dark:text-green-400");
  });

  // --- 権限バッジ（アクションボタン）の暗クラス ---
  it("テンプレート許可バッジに暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-blue-500/15");
  });
  it("上書き許可バッジに暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-green-500/15");
  });
  it("上書き拒否バッジに暗背景クラスがある", () => {
    expect(permissionsPage).toContain("dark:bg-red-500/15");
  });
  it("未許可バッジに暗背景クラスがある", () => {
    // gray-100 → dark:bg-gray-800
    expect(permissionsPage).toContain("dark:bg-gray-800");
  });

  // --- ライト側不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(permissionsPage).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている", () => {
    expect(permissionsPage).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(permissionsPage).toContain("border-gray-200");
  });
  it("ライトモード hover:bg-gray-50 は残っている", () => {
    expect(permissionsPage).toContain("hover:bg-gray-50");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(permissionsPage).toContain("text-gray-500");
  });
  it("ライトモード bg-blue-100 は残っている", () => {
    expect(permissionsPage).toContain("bg-blue-100");
  });
  it("ライトモード bg-green-100 は残っている", () => {
    expect(permissionsPage).toContain("bg-green-100");
  });
  it("ライトモード bg-red-100 は残っている", () => {
    expect(permissionsPage).toContain("bg-red-100");
  });
  it("ライトモード bg-gray-100 は残っている", () => {
    expect(permissionsPage).toContain("bg-gray-100");
  });
});
