import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
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

describe("C-3: 謄本取得の資格情報画面は廃止(メニュー再編・2026-08-24)", () => {
  // ⚠この画面は**発注者決定で撤去**した(謄本は共通アカウントから取る運用のため)。
  //   保存ボタンの無効化条件を守っていた C-3 は、対象ごと無くなったので
  //   「画面が存在しないこと」を守る形に置き換える。
  //   取得機能の本体(env 経由の資格情報の解決)は残っている=挙動は不変。
  it("画面のソースが存在しない", () => {
    expect(
      existsSync(
        path.resolve(process.cwd(), "src/app/(dashboard)/admin/registry-settings/page.tsx"),
      ),
    ).toBe(false);
  });
});


describe("C-6: 淡色の警告/エラーカードがダークモード対応(UI総点検)", () => {
  it("ログインのエラーカードが dark:bg を持つ", () => {
    const src = read("src/app/(auth)/login/page.tsx");
    expect(src).toMatch(/bg-red-50[^"]*dark:bg-red-950/);
  });

  it("物件一覧のエラー/一括操作バーが dark を持つ", () => {
    const src = read("src/app/(dashboard)/properties/page.tsx");
    expect(src).toMatch(/bg-red-50[^"]*dark:bg-red-950/);
    expect(src).toMatch(/bg-blue-50[^"]*dark:bg-blue-950/);
  });

  it("品質チェックの重要度カード設定に dark が入っている", () => {
    const src = read("src/app/(dashboard)/properties/quality-check/page.tsx");
    expect(src).toContain("dark:bg-red-950/40");
    expect(src).toContain("dark:bg-amber-950/40");
    expect(src).toContain("dark:bg-blue-950/40");
  });

  it("謄本取得の資格情報など主要画面のエラーカードが dark を持つ", () => {
    const src = read("src/app/(dashboard)/admin/owners/quality-audit/page.tsx");
    expect(src).toMatch(/bg-red-50[^"]*dark:bg-red-950/);
  });
});
