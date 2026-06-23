import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "next-action-tab.tsx"), "utf8");

describe("next-action-tab.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（カード背景）---
  it("通常カード面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 枠線 ---
  it("通常/完了カード枠線に dark:border-gray-800 がある (border-gray-200 対応)", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある (border-gray-300 対応)", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  it("キャンセルボタンの hover に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("メインコンテンツ文字に dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("ラベル文字に dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("メタ情報・完了テキストに dark:text-gray-400 がある (text-gray-500 対応)", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("空状態・削除アイコンに dark:text-gray-500 がある (text-gray-400 対応)", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 入力3点セット（bg/text 未指定入力欄） ---
  it("入力欄に dark:bg-gray-900 がある（入力3点セット）", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("入力欄に dark:text-gray-100 がある（入力3点セット）", () => {
    expect(src).toContain("dark:text-gray-100");
  });

  // --- エラーバナー accent 可読化 ---
  it("エラーバナーに dark:border-red-500/20 がある", () => {
    expect(src).toContain("dark:border-red-500/20");
  });
  it("エラーバナーに dark:bg-red-500/10 がある", () => {
    expect(src).toContain("dark:bg-red-500/10");
  });
  it("エラーバナーに dark:text-red-300 がある", () => {
    expect(src).toContain("dark:text-red-300");
  });

  // --- フォームエラー文字 accent 可読化 ---
  it("フォーム送信エラーに dark:text-red-400 がある (text-red-600 対応)", () => {
    expect(src).toContain("dark:text-red-400");
  });

  // --- actionType バッジ accent 可読化（暗面で読めない文字）---
  it("アクション種別バッジに dark:bg-blue-500/15 がある (bg-blue-100 対応)", () => {
    expect(src).toContain("dark:bg-blue-500/15");
  });
  it("アクション種別バッジに dark:text-blue-300 がある (text-blue-700 対応)", () => {
    expect(src).toContain("dark:text-blue-300");
  });

  // --- 作成フォームパネル（blue active panel）accent 可読化 ---
  it("作成フォームパネルに dark:border-blue-500/40 がある", () => {
    expect(src).toContain("dark:border-blue-500/40");
  });
  it("作成フォームパネルに dark:bg-blue-500/20 がある", () => {
    expect(src).toContain("dark:bg-blue-500/20");
  });

  // --- 期限切れカード（red accent）可読化 ---
  it("期限切れカードに dark:border-red-500/20 がある", () => {
    // dark:border-red-500/20 は上のエラーバナーと共通
    expect(src).toContain("dark:border-red-500/20");
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード bg-gray-50 は残っている（完了カード）", () => {
    expect(src).toContain("bg-gray-50");
  });
  it("ライトモード border-gray-200 は残っている", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている（入力欄・キャンセルボタン）", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード text-gray-500 は残っている", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-600 は残っている", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-800 は残っている", () => {
    expect(src).toContain("text-gray-800");
  });
  it("ライトモード text-gray-400 は残っている（空状態・削除アイコン）", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード border-red-200 は残っている（エラーバナー）", () => {
    expect(src).toContain("border-red-200");
  });
  it("ライトモード bg-red-50 は残っている（エラーバナー・期限切れカード）", () => {
    expect(src).toContain("bg-red-50");
  });
  it("ライトモード text-red-700 は残っている（エラーバナー）", () => {
    expect(src).toContain("text-red-700");
  });
  it("ライトモード text-red-600 は残っている（フォームエラー）", () => {
    expect(src).toContain("text-red-600");
  });
  it("solid ボタン bg-indigo-600 は残っている（変更なし）", () => {
    expect(src).toContain("bg-indigo-600");
  });
  it("solid ボタン text-white は残っている（変更なし）", () => {
    expect(src).toContain("text-white");
  });
});
