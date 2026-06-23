import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "comment-tab.tsx"), "utf8");

describe("comment-tab.tsx dark: 配色 (物件詳細タブ群)", () => {
  // --- 面（カード背景）---
  it("コメントカード面に dark:bg-gray-900 がある (bg-white 対応)", () => {
    expect(src).toContain("dark:bg-gray-900");
  });

  // --- 枠線 ---
  it("コメントカード枠線に dark:border-gray-800 がある (border-gray-200 対応)", () => {
    expect(src).toContain("dark:border-gray-800");
  });
  it("返信インデント枠線に dark:border-gray-800 がある (border-gray-100 対応)", () => {
    // border-gray-100 も dark:border-gray-800 へ
    expect(src).toContain("dark:border-gray-800");
  });
  it("入力欄枠線に dark:border-gray-700 がある (border-gray-300 対応)", () => {
    expect(src).toContain("dark:border-gray-700");
  });

  // --- hover ---
  it("取消ボタンの hover に dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });

  // --- 文字 ---
  it("投稿者名に dark:text-gray-100 がある (text-gray-800 対応)", () => {
    expect(src).toContain("dark:text-gray-100");
  });
  it("返信者名/本文見出しに dark:text-gray-200 がある (text-gray-700 対応)", () => {
    expect(src).toContain("dark:text-gray-200");
  });
  it("返信本文に dark:text-gray-300 がある (text-gray-600 対応)", () => {
    expect(src).toContain("dark:text-gray-300");
  });
  it("メタ情報に dark:text-gray-400 がある (text-gray-500 対応)", () => {
    expect(src).toContain("dark:text-gray-400");
  });
  it("タイムスタンプ/空状態に dark:text-gray-500 がある (text-gray-400 対応)", () => {
    expect(src).toContain("dark:text-gray-500");
  });

  // --- 入力3点セット（textarea bg/text 未指定）---
  it("textarea に dark:bg-gray-900 がある（入力3点セット）", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("textarea に dark:text-gray-100 がある（入力3点セット）", () => {
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

  // --- 返信リンク accent 可読化 ---
  it("返信ボタンに dark:text-indigo-400 がある (text-indigo-600 対応)", () => {
    expect(src).toContain("dark:text-indigo-400");
  });
  it("返信ボタン hover に dark:hover:text-indigo-300 がある (hover:text-indigo-800 対応)", () => {
    expect(src).toContain("dark:hover:text-indigo-300");
  });

  // --- ライト不変担保 ---
  it("ライトモード bg-white は残っている（コメントカード）", () => {
    expect(src).toContain("bg-white");
  });
  it("ライトモード border-gray-200 は残っている（コメントカード枠）", () => {
    expect(src).toContain("border-gray-200");
  });
  it("ライトモード border-gray-300 は残っている（入力欄・取消ボタン）", () => {
    expect(src).toContain("border-gray-300");
  });
  it("ライトモード border-gray-100 は残っている（返信インデント）", () => {
    expect(src).toContain("border-gray-100");
  });
  it("ライトモード text-gray-800 は残っている（投稿者名）", () => {
    expect(src).toContain("text-gray-800");
  });
  it("ライトモード text-gray-700 は残っている（本文・返信者名）", () => {
    expect(src).toContain("text-gray-700");
  });
  it("ライトモード text-gray-600 は残っている（返信本文・取消テキスト）", () => {
    expect(src).toContain("text-gray-600");
  });
  it("ライトモード text-gray-500 は残っている（ローディング）", () => {
    expect(src).toContain("text-gray-500");
  });
  it("ライトモード text-gray-400 は残っている（空状態・タイムスタンプ）", () => {
    expect(src).toContain("text-gray-400");
  });
  it("ライトモード border-red-200 は残っている（エラーバナー）", () => {
    expect(src).toContain("border-red-200");
  });
  it("ライトモード bg-red-50 は残っている（エラーバナー）", () => {
    expect(src).toContain("bg-red-50");
  });
  it("ライトモード text-red-700 は残っている（エラーバナー）", () => {
    expect(src).toContain("text-red-700");
  });
  it("ライトモード text-red-600 は残っている（フォームエラー）", () => {
    expect(src).toContain("text-red-600");
  });
  it("ライトモード text-indigo-600 は残っている（返信リンク）", () => {
    expect(src).toContain("text-indigo-600");
  });
  it("solid ボタン bg-indigo-600 は残っている（変更なし）", () => {
    expect(src).toContain("bg-indigo-600");
  });
  it("solid ボタン text-white は残っている（変更なし）", () => {
    expect(src).toContain("text-white");
  });
});
