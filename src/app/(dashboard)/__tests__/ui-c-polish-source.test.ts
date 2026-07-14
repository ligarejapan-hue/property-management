import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// env=node(jsdom 無し)のため、UI 配線の回帰はソース文字列で守る。
const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("C-1: ログインのパスワード表示切替(UI総点検)", () => {
  const src = read("src/app/(auth)/login/page.tsx");

  it("表示/非表示トグルがある", () => {
    expect(src).toContain("showPassword");
    expect(src).toContain('type={showPassword ? "text" : "password"}');
    expect(src).toContain("パスワードを表示"); // aria-label
  });
});

describe("C-2: 取込ボタンは0件のとき非活性を明示(UI総点検)", () => {
  const src = read("src/app/(dashboard)/import/page.tsx");

  it("0件では disabled、かつ無効時はグレーにして緑のままにしない", () => {
    expect(src).toContain("toCreateCount === 0"); // 0件で disabled
    expect(src).toContain("disabled:bg-gray-200"); // 無効時はグレー
  });
});
