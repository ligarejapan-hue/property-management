/**
 * 「貼り付けて物件化」画面の PII 保護（@codex PR#414 3巡目）。
 *
 * ScreenProtectionGuard は `[data-pii-protected]` の**内側でしか**
 * コピー・右クリック・印刷を抑止・監査しない。この画面は
 *   ・貼った原文（＝資料まるごと）
 *   ・所有者の氏名・住所・電話・メール
 * が同じ画面に並ぶ＝この機能でいちばん個人情報が濃い。兄弟の取込画面3つ
 * （import / import/registry-dm / import/jobs/[jobId]）は全て印が付いており、
 * この画面だけが保護の外に居た。
 *
 * ⚠**属性が「どこかに在る」だけのテストにしない**。入れ物を間違えると
 *   （例: 貼り付け欄の section にだけ付ける）、外に出た部分は無防備なまま
 *   テストは緑になる。ここでは「**最上位の入れ物**に付いている」ことと
 *   「原文の表示と所有者の欄がその内側にある」ことを見る。
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PasteImportReview } from "@/components/import/paste-import-review";
import { buildPasteDraft } from "@/lib/paste-import/build-draft";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/import/paste",
  useSearchParams: () => new URLSearchParams(),
}));

import PasteImportPage from "../page";

const dir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(dir, "../page.tsx"), "utf8");

const html = renderToStaticMarkup(createElement(PasteImportPage));

/** return( の直後に現れる最初の JSX タグ（＝この画面の最上位の入れ物）。 */
function firstTagOfReturn(src: string): string {
  const at = src.indexOf("\n  return (");
  expect(at).toBeGreaterThanOrEqual(0);
  const tag = /<[A-Za-z][^>]*>/.exec(src.slice(at));
  expect(tag).not.toBeNull();
  return tag![0];
}

describe("画面の最上位の入れ物が PII 保護対象になっている", () => {
  it("★描画した結果の**根っこの要素**が data-pii-protected を持つ", () => {
    // 内側の要素に付け替えると、根っこは素の <div> になり落ちる。
    expect(html.startsWith("<div data-pii-protected")).toBe(true);
    expect(html).toContain('data-pii-surface="import"');
  });

  it("★貼り付け欄が保護領域の内側にある（印より後ろに出る）", () => {
    const protectedAt = html.indexOf("data-pii-protected");
    const textareaAt = html.indexOf('id="paste-raw-text"');
    expect(protectedAt).toBeGreaterThanOrEqual(0);
    expect(textareaAt).toBeGreaterThan(protectedAt);
    // 保護領域は画面の最後まで続く（途中で閉じて残りが外に出ていない）。
    expect(html.trimEnd().endsWith("</div>")).toBe(true);
  });

  it("★兄弟の取込画面と同じ書き方（data-pii-surface=\"import\"）", () => {
    const siblings = [
      "../../page.tsx",
      "../../registry-dm/page.tsx",
    ].map((rel) => readFileSync(join(dir, rel), "utf8"));
    for (const sib of siblings) {
      expect(sib).toContain('data-pii-protected data-pii-surface="import"');
    }
    expect(source).toContain('data-pii-protected data-pii-surface="import"');
  });
});

describe("原文の表示と所有者の欄が保護領域の内側にある", () => {
  it("★確認画面(PasteImportReview)は最上位の入れ物の内側で描かれる", () => {
    // 確認画面は draft が入ってから描かれる（この env では state を動かせない）ので、
    // 「最上位の入れ物＝印の付いた要素」であることと、確認画面がその return の
    // 中で描かれていることを合わせて見る。印を内側の要素へ移すと1つ目で落ちる。
    const rootTag = firstTagOfReturn(source);
    expect(rootTag).toContain("data-pii-protected");
    expect(rootTag).toContain('data-pii-surface="import"');

    const rootAt = source.indexOf(rootTag);
    const reviewAt = source.indexOf("<PasteImportReview");
    const textareaAt = source.indexOf('id="paste-raw-text"');
    expect(reviewAt).toBeGreaterThan(rootAt);
    expect(textareaAt).toBeGreaterThan(rootAt);
  });

  it("★その確認画面が実際に原文と所有者の欄を描いている（守る中身があることの裏取り）", () => {
    const draft = buildPasteDraft(
      "■物件所在地： 東京都A区B1-2-3\n■お名前： 山田太郎\n■電話番号： 09012345678",
    );
    const out = renderToStaticMarkup(
      createElement(PasteImportReview, {
        draft,
        rawText: "■お名前： 山田太郎\n■電話番号： 09012345678",
      }),
    );
    // 原文の表示
    expect(out).toContain("貼った原文");
    expect(out).toContain("09012345678");
    // 所有者の欄
    expect(out).toContain('id="paste-field-owner-name"');
    expect(out).toContain('id="paste-field-owner-phone"');
  });
});
