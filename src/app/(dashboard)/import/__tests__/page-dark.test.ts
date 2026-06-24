import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "..", "page.tsx"), "utf8");

describe("import/page.tsx dark: 配色", () => {
  // 面
  it("カード/パネル面に dark:bg-gray-900 がある", () => {
    expect(src).toContain("dark:bg-gray-900");
  });
  it("淡面に dark:bg-gray-800/50 または dark:bg-gray-800 がある", () => {
    expect(src.includes("dark:bg-gray-800/50") || src.includes("dark:bg-gray-800")).toBe(true);
  });
  it("行/ボタンhoverに dark:hover:bg-gray-800 がある", () => {
    expect(src).toContain("dark:hover:bg-gray-800");
  });
  // 文字
  it("本文に dark:text-gray-100 がある", () => { expect(src).toContain("dark:text-gray-100"); });
  it("本文に dark:text-gray-200 がある", () => { expect(src).toContain("dark:text-gray-200"); });
  it("本文に dark:text-gray-300 がある", () => { expect(src).toContain("dark:text-gray-300"); });
  it("薄文字に dark:text-gray-400 がある", () => { expect(src).toContain("dark:text-gray-400"); });
  // 枠線
  it("枠線に dark:border-gray-800 がある", () => { expect(src).toContain("dark:border-gray-800"); });
  it("枠線に dark:border-gray-700 がある", () => { expect(src).toContain("dark:border-gray-700"); });
  it("区切りに dark:divide-gray-800 がある", () => { expect(src).toContain("dark:divide-gray-800"); });
  // accent: アクティブタブ
  it("アクティブタブに dark:text-indigo-400 がある", () => { expect(src).toContain("dark:text-indigo-400"); });
  it("アクティブタブ枠線に dark:border-indigo-400 がある", () => { expect(src).toContain("dark:border-indigo-400"); });
  // accent: 色付きメッセージpanel（情報/警告/成功/エラー）
  it("情報panel(blue)に dark:text-blue-300 がある", () => { expect(src).toContain("dark:text-blue-300"); });
  it("警告panel(amber)に dark:text-amber-300 がある", () => { expect(src).toContain("dark:text-amber-300"); });
  it("成功panel(green)に dark:text-green-300 がある", () => { expect(src).toContain("dark:text-green-300"); });
  it("エラーpanel(red)に dark:text-red-300 がある", () => { expect(src).toContain("dark:text-red-300"); });
  it("色付きpanel地に dark:bg-blue-500/10 がある", () => { expect(src).toContain("dark:bg-blue-500/10"); });
  // ライト不変ガード
  it("ライト bg-white は残っている", () => { expect(src).toContain("bg-white"); });
  it("ライト text-gray-600 は残っている", () => { expect(src).toContain("text-gray-600"); });
  it("ライト border-gray-300 は残っている", () => { expect(src).toContain("border-gray-300"); });
  it("ライト hover:bg-gray-50 は残っている", () => { expect(src).toContain("hover:bg-gray-50"); });
  it("ライト text-blue-700 は残っている", () => { expect(src).toContain("text-blue-700"); });
});

// 事前敵対レビューで「取込履歴テーブルが丸ごと未ダーク化」だった回帰を固定する。
// 上の汎用 token 断言は panel 側に同 token があると素通りするため、テーブル固有の
// 結合文字列で「テーブル自体がダーク化されている」ことを直接ピン留めする。
describe("import/page.tsx dark: 取込履歴テーブル(Job History) カバレッジ固定", () => {
  it("thead 淡面に dark:bg-gray-800/50 が付く", () => {
    expect(src).toContain("dark:bg-gray-800/50");
  });
  it("tbody 区切りが divide-gray-100 dark:divide-gray-800", () => {
    expect(src).toContain("divide-y divide-gray-100 dark:divide-gray-800");
  });
  it("件数列(新規/更新/要レビュー/エラー)の文字に dark: が付く", () => {
    expect(src).toContain("text-green-700 dark:text-green-300 font-medium");
    expect(src).toContain("text-blue-700 dark:text-blue-300 font-medium");
    expect(src).toContain("text-amber-700 dark:text-amber-300 font-medium");
    expect(src).toContain("text-red-700 dark:text-red-300 font-medium");
  });
  it("ファイル名リンクに text-indigo-600 dark:text-indigo-400 が付く", () => {
    expect(src).toContain("text-indigo-600 dark:text-indigo-400");
  });
  it("件数プレースホルダに text-gray-300 dark:text-gray-600 が付く", () => {
    expect(src).toContain("text-gray-300 dark:text-gray-600");
  });
});
