import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// env=node(jsdom 無し)のため、UI 文言/導線の回帰はソース文字列で守る。
const read = (p: string) => readFileSync(path.resolve(process.cwd(), p), "utf-8");

describe("B-10: 物件詳細の操作群に見出しを付ける(UI総点検)", () => {
  const src = read("src/components/properties/action-bar.tsx");

  it("操作群の見出しがある(色付きボタンをステータスバッジと区別)", () => {
    expect(src).toContain("この物件で行える操作");
  });
});

describe("B-12: マンション棟一覧の空状態に登録CTAを置く(UI総点検)", () => {
  const src = read("src/app/(dashboard)/buildings/page.tsx");

  it("本当の空(検索なし)のときだけ登録CTAで登録モーダルへ導く", () => {
    expect(src).toContain("最初のマンション棟を登録");
    expect(src).toContain("マンション棟がまだ登録されていません");
    expect(src).toContain("setShowCreate(true)");
  });

  it("検索0件と本当の空を区別する(検索0件では登録CTAを出さない・@codex)", () => {
    expect(src).toContain("に一致するマンション棟が見つかりません"); // 検索0件の文言
    expect(src).toContain("{keyword ? ("); // keyword で出し分け
  });
});
