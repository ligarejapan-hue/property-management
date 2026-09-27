import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 2026-09-26 発注者の実機テストで詰まった所の直し(UI 文言・配線の走査)。
const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n");

describe("LP型の欄の案内", () => {
  const src = read("../../components/sale-dm/lp-variant-manager.tsx");

  it("公開済みのご案内ページを「次の段階」と書かない(9/16 から公開中)", () => {
    expect(src).not.toContain("当面これまでどおり外部LP");
    expect(src).not.toContain("次の段階で公開されます");
  });

  it("LP型が無いときは作り方(ラベル→保存→書類のアイコンで文章)を案内する", () => {
    expect(src).toContain("「LP型を追加」");
    expect(src).toContain("書類のアイコン");
  });

  it("ラベルが空だと保存が押せない理由を、欄の近くに出す", () => {
    expect(src).toContain("ラベルを入れると保存できます");
    expect(src).toMatch(/placeholder="例: /);
  });
});

import { lpSplitIssueMessage } from "../sale-dm-letter/lp-template";

describe("LP文章の「知らない見出し」の案内", () => {
  it("【】で囲んだ言葉は見出しとして読まれる、と直し方まで書く(2026-09-26 見出しの中の【テスト】で止まった)", () => {
    const m = lpSplitIssueMessage({ code: "UNKNOWN_SECTION", section: "テスト" } as never);
    expect(m).toContain("知らない見出し「テスト」");
    expect(m).toContain("【】で囲んだ言葉は見出しとして読まれます");
  });
});

describe("物件一覧: 売却DMを作れなかった理由はその場で見せる", () => {
  it("作成の失敗は画面下の赤帯(再試行=一覧の読み直し)ではなく、その場の案内で出す", () => {
    const src = read("../../app/(dashboard)/properties/page.tsx");
    expect(src).toContain('window.alert(err instanceof Error ? err.message : "売却DMの作成に失敗しました")');
    expect(src).not.toContain('setError(err instanceof Error ? err.message : "売却DMの作成に失敗しました")');
  });
});
