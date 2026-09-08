/**
 * Phase F-2a UI source-assertion テスト。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const pageSrc = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/(dashboard)/import/registry-pdf/page.tsx",
  ),
  "utf8",
);

// コメントを取り除く。⚠経緯の説明はコメントに書き残したいので、
// 「画面に出るか」を見る検査はコメントを外してから行う。
// 行頭が // の行と、ブロックコメントだけを落とす(URL の // は残す)。
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("registry-pdf page Phase F-2a 強化 UI", () => {
  it("scanned 警告バナーは既存 data-testid を維持する（F-1 互換）", () => {
    expect(pageSrc).toMatch(/data-testid="scanned-pdf-banner"/);
    expect(pageSrc).toMatch(/画像化された謄本PDFです/);
  });

  it("⚠バナーに OCR の語を出さない(2026-09-08 発注者判断で画面から撤去)", () => {
    // ⚠**機能そのものは残っている**(src/lib/registry-ocr/* と ocr-draft route)。
    //   消したのは**画面の導線と文言だけ**。実測で「横向き・低品質のスキャンは
    //   文字数が1/3しか拾えない」と分かり、あると期待させてしまうため。
    // ⚠**コメントを取り除いてから**見る。経緯をコメントに書き残せるようにしつつ、
    //   文字列リテラルだけでなく **JSX の素のテキスト**も取りこぼさない。
    expect(stripComments(pageSrc)).not.toMatch(/OCR/i);
    // 代わりに「どうすればよいか」を書く
    expect(pageSrc).toMatch(/テキストを貼り付けるモード/);
  });

  it("F-2a: 「テキストを貼り付けるモードに切り替える」ボタンがある", () => {
    expect(pageSrc).toMatch(/data-testid="scanned-pdf-switch-to-paste"/);
    expect(pageSrc).toMatch(/テキストを貼り付けるモードに切り替える/);
  });

  it("F-2a: 切替ボタンは paste タブに切り替え、text を空にする（不完全 embedded_text を投入しない）", () => {
    const buttonMatch = pageSrc.match(
      /scanned-pdf-switch-to-paste[\s\S]{0,1200}<\/button>/,
    );
    expect(buttonMatch).not.toBeNull();
    const body = buttonMatch?.[0] ?? "";
    expect(body).toMatch(/setUploadTab\("text"\)/);
    expect(body).toMatch(/setText\(""\)/);
    expect(body).toMatch(/setSelectedFile\(null\)/);
    expect(body).toMatch(/setIsLikelyScanned\(false\)/);
    expect(body).not.toMatch(/setText\(text\)/);
    expect(body).not.toMatch(/setText\(extracted/);
  });

  it("F-2a: parse response の extraction.source / embeddedTextLength を読む", () => {
    expect(pageSrc).toMatch(/extraction\?\.source\s*===\s*"likely_scanned"/);
    expect(pageSrc).toMatch(/extraction\?\.embeddedTextLength/);
    expect(pageSrc).toMatch(/setEmbeddedTextLength/);
  });

  it("F-2a: 抽出文字数のみ画面表示（本文・raw text は持ち出さない）", () => {
    expect(pageSrc).toMatch(/取り出せた文字数:\s*\{embeddedTextLength\}\s*文字/);
    expect(pageSrc).not.toMatch(/_rawTextPreview/);
    expect(pageSrc).not.toMatch(/result\.rawText/);
  });

  it("ローカル OCR エンジンをページに同梱しない(PII持ち出し防止・bundle肥大回避)", () => {
    expect(pageSrc).not.toMatch(/tesseract/i);
    expect(pageSrc).not.toMatch(/from\s+"sharp"/);
    // ⚠画面からの呼び出し(requestRegistryOcrDraft)は 2026-09-08 に撤去した。
    //   サーバー側の route は残っている(復活はこの1行を戻すだけ)。
    expect(pageSrc).not.toMatch(/requestRegistryOcrDraft/);
  });

  it("F-2a: 既存 isLikelyScanned 後方互換読みも残す", () => {
    expect(pageSrc).toMatch(/result\.isLikelyScanned\s*===\s*true/);
  });
});
